// Снимает экраны Lexio для README: регистрирует демо-пользователя, через API
// проходит несколько пуллов (чтобы статистика не была пустой) и фотографирует
// страницы в светлой теме. Если `npm run dev` уже запущен — использует его,
// иначе поднимает сам и гасит в конце.
//
//   npm run screenshots
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

// Vite по умолчанию слушает только localhost, который может резолвиться в ::1 —
// поэтому проверяем оба адреса, а свой экземпляр поднимаем явно на 127.0.0.1.
const FRONTEND_CANDIDATES = process.env.LEXIO_FRONTEND_URL
    ? [process.env.LEXIO_FRONTEND_URL]
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
const API = process.env.LEXIO_API_URL ?? 'http://127.0.0.1:4000/api';
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');
const VIEWPORT = { width: 1440, height: 900 };

interface Question {
    wordId: number;
    prompt: string;
}
interface PoolState {
    pool: { id: string };
    progress: { solved: number; total: number };
    question: Question | null;
}
interface AnswerResult {
    isCorrect: boolean;
    correctAnswer: string;
}

async function isUp(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return response.ok;
    }
    catch {
        return false;
    }
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isUp(url))
            return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`${url} не ответил за ${timeoutMs / 1000} с`);
}

async function findFrontend(): Promise<string | null> {
    for (const url of FRONTEND_CANDIDATES) {
        if (await isUp(url))
            return url;
    }
    return null;
}

function startDev(command: string): ChildProcess {
    const child = spawn(command, {
        cwd: path.resolve(__dirname, '..'),
        shell: true,
        stdio: 'ignore',
        detached: process.platform !== 'win32',
    });
    child.on('error', (error) => console.error(`Не удалось запустить ${command}:`, error));
    return child;
}

function stopDev(child: ChildProcess): void {
    if (child.pid === undefined)
        return;
    // npm → concurrently → tsx/vite: гасим всё дерево, иначе порты останутся заняты.
    if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else
        process.kill(-child.pid, 'SIGTERM');
}

async function call<T>(token: string | null, method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${route}`, {
        method,
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`${method} ${route} → ${response.status}: ${text}`);
    return JSON.parse(text) as T;
}

async function register(): Promise<string> {
    const stamp = Date.now();
    const { token } = await call<{ token: string }>(null, 'POST', '/auth/register', {
        email: `demo-${stamp}@lexio.local`,
        password: `demo-${stamp}-password`,
        name: 'Алекс',
        cefrLevel: 'B1',
        timezoneOffset: -new Date().getTimezoneOffset(),
    });
    return token;
}

// Каждое третье слово при первом показе отвечаем неверно: так в статистике есть
// и ошибки, и слабые слова, а пулл всё равно закрывается на повторном круге.
async function answerQuestions(token: string, state: PoolState, limit = Infinity): Promise<PoolState> {
    const known = new Map<number, string>();
    let asked = 0;
    while (state.question && asked < limit) {
        const { wordId } = state.question;
        let answer = known.get(wordId);
        if (answer === undefined) {
            if (asked % 3 === 2) {
                answer = 'не знаю';
            }
            else {
                const detail = await call<{ word: { translations: string[] } }>(token, 'GET', `/words/${wordId}`);
                answer = detail.word.translations[0] ?? 'не знаю';
            }
        }
        const { result, state: next } = await call<{ result: AnswerResult; state: PoolState }>(token, 'POST', `/practice/pools/${state.pool.id}/answer`, { wordId, answer, responseMs: 2500 + (asked % 5) * 900 });
        if (!result.isCorrect)
            known.set(wordId, result.correctAnswer);
        state = next;
        asked++;
    }
    return state;
}

async function seedProgress(token: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
        const state = await call<PoolState>(token, 'POST', '/practice/pools', {
            mode: 'classic',
            size: 12,
            direction: 'en_ru',
            answerFormat: 'typed',
        });
        await answerQuestions(token, state);
    }
    // Незакрытый пулл — его показываем на экране тренажёра.
    const active = await call<PoolState>(token, 'POST', '/practice/pools', {
        mode: 'classic',
        size: 15,
        direction: 'en_ru',
        answerFormat: 'typed',
    });
    await answerQuestions(token, active, 4);
}

async function settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle');
    // Loading рендерит текст рядом со спиннером; ждём, пока все такие блоки исчезнут.
    await page.waitForFunction(() => document.querySelectorAll('.animate-spin').length === 0, null, { timeout: 15000 });
    await page.waitForTimeout(600);
}

async function shoot(page: Page, frontend: string, route: string, file: string): Promise<void> {
    await page.goto(`${frontend}${route}`);
    await settle(page);
    await page.screenshot({ path: path.join(OUT_DIR, file) });
    console.log(`  ✓ ${file}`);
}

async function main(): Promise<void> {
    const started: ChildProcess[] = [];
    let browser: Browser | null = null;
    try {
        if (!(await isUp(`${API}/health`))) {
            console.log('Запускаю backend…');
            started.push(startDev('npm run dev --workspace backend'));
            await waitFor(`${API}/health`, 90000);
        }
        let frontend = await findFrontend();
        if (!frontend) {
            console.log('Запускаю frontend…');
            frontend = 'http://127.0.0.1:5173';
            started.push(startDev('npm run dev --workspace frontend -- --host 127.0.0.1 --strictPort'));
            await waitFor(frontend, 90000);
        }
        browser = await chromium.launch();
        const health = await call<{ aiEnabled: boolean }>(null, 'GET', '/health');
        console.log('Регистрирую демо-пользователя и прохожу пуллы…');
        const token = await register();
        await seedProgress(token);
        const { state } = await call<{ state: PoolState | null }>(token, 'GET', '/practice/pools/active');
        if (!state)
            throw new Error('Нет активного пулла для экрана тренажёра');

        await mkdir(OUT_DIR, { recursive: true });
        const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light', locale: 'ru-RU' });
        await context.addInitScript((value) => {
            localStorage.setItem('lexio.token', value);
            localStorage.setItem('lexio.theme', 'light');
        }, token);
        const page = await context.newPage();
        page.on('pageerror', (error) => console.error('Ошибка на странице:', error.message));

        console.log('Снимаю экраны…');
        await shoot(page, frontend, '/', 'dashboard.png');
        await shoot(page, frontend, `/practice/session/${state.pool.id}`, 'practice.png');
        await shoot(page, frontend, '/dictionary', 'dictionary.png');
        await shoot(page, frontend, '/stats', 'stats.png');
        await shoot(page, frontend, '/rewards', 'rewards.png');
        if (health.aiEnabled) {
            await shoot(page, frontend, '/ai', 'ai-tasks.png');
            await shoot(page, frontend, '/chat', 'chat.png');
        }
        else {
            console.log('  — OPENAI_API_KEY не задан, экраны ИИ пропущены');
        }
        await context.close();
    }
    finally {
        await browser?.close();
        started.forEach(stopDev);
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
