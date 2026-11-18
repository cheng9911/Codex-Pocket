export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const timeout = controller && setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers:
        body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Pocket-Client': 'web' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ApiError(response.ok ? 502 : response.status, '主机返回了无法读取的响应，请重试。');
    }
    if (!response.ok) throw new ApiError(response.status, data?.error ?? '请求失败');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, controller?.signal.aborted
      ? '等待主机响应超时，请稍后重试。'
      : '暂时连不上主机，请检查网络后重试。');
  } finally {
    clearTimeout(timeout);
  }
}
export function operation() {
  return crypto.randomUUID();
}
