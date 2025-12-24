import chalk from 'chalk';

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

function getTimestamp(): string {
    return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string): string {
    const timestamp = chalk.gray(`[${getTimestamp()}]`);
    const levelColors: Record<LogLevel, typeof chalk.blue> = {
        info: chalk.blue,
        success: chalk.green,
        warn: chalk.yellow,
        error: chalk.red,
        debug: chalk.magenta,
    };

    const levelStr = levelColors[level](`[${level.toUpperCase()}]`);
    return `${timestamp} ${levelStr} ${message}`;
}

export const logger = {
    info: (message: string) => console.log(formatMessage('info', message)),
    success: (message: string) => console.log(formatMessage('success', message)),
    warn: (message: string) => console.warn(formatMessage('warn', message)),
    error: (message: string) => console.error(formatMessage('error', message)),
    debug: (message: string) => {
        if (process.env.DEBUG === 'true') {
            console.log(formatMessage('debug', message));
        }
    },
};

/**
 * Delay execution for specified milliseconds
 */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: {
        maxAttempts?: number;
        initialDelayMs?: number;
        maxDelayMs?: number;
        onRetry?: (attempt: number, error: Error) => void;
    } = {}
): Promise<T> {
    const {
        maxAttempts = 3,
        initialDelayMs = 1000,
        maxDelayMs = 30000,
        onRetry,
    } = options;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;

            if (attempt === maxAttempts) {
                break;
            }

            const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);

            if (onRetry) {
                onRetry(attempt, error);
            }

            logger.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
            await delay(delayMs);
        }
    }

    throw lastError;
}

/**
 * Format domain for display
 */
export function formatDomain(domain: string): string {
    return chalk.cyan(domain);
}
