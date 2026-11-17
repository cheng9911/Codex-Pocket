import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as ChildProcess from 'effect/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { makeCodexAppServerPatchedProtocol } from './vendor/src/protocol.ts';
import {
  makeChildStdio,
  makeStderrTail,
  makeTerminationError,
} from './vendor/src/_internal/stdio.ts';
import { CodexAppServerRequestError } from './vendor/src/errors.ts';

export type WireParams = Record<string, any>;
export interface TransportOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  notification?: (method: string, params: WireParams) => void;
  request?: (method: string, params: WireParams) => Promise<unknown>;
  terminated?: (error: string) => void;
}

/** Owns only the child it starts. No access to the desktop app's daemon. */
export async function openTransport(options: TransportOptions = {}) {
  const scope = Scope.makeUnsafe('parallel');
  const program = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        options.command ?? process.env.CODEX_BIN ?? 'codex',
        options.args ?? ['app-server', '--listen', 'stdio://'],
        {
          cwd: options.cwd,
          env: options.env,
          extendEnv: true,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ),
    );
    const stderr = yield* makeStderrTail(child.stderr);
    const protocol = yield* makeCodexAppServerPatchedProtocol({
      stdio: makeChildStdio(child, stderr.awaitDrained),
      terminationError: makeTerminationError(child, stderr.read),
      // Use the upstream raw envelope transport. Payload compatibility is handled
      // by our adapter; schema drift must never silently drop an approval/event.
      onNotification: (n) =>
        Effect.sync(() => options.notification?.(n.method, (n.params ?? {}) as WireParams)),
      onRequest: (r) =>
        Effect.tryPromise({
          try: () =>
            options.request
              ? options.request(r.method, {
                  ...((r.params ?? {}) as WireParams),
                  _nativeRequestId: r.id,
                })
              : Promise.reject(new Error('Unsupported request')),
          catch: () => CodexAppServerRequestError.internalError(),
        }),
      onTermination: (error) => Effect.sync(() => options.terminated?.(String(error))),
    });
    return { protocol, pid: child.pid };
  });
  try {
    const { protocol, pid } = await Effect.runPromise(
      program.pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
    );
    let closed = false;
    return {
      pid,
      async request<T = WireParams>(method: string, params?: unknown): Promise<T> {
        return Effect.runPromise(
          protocol.request(method, params).pipe(Effect.timeout('60 seconds')),
        ) as Promise<T>;
      },
      async notify(method: string, params?: unknown) {
        await Effect.runPromise(protocol.notify(method, params));
      },
      async close() {
        if (!closed) {
          closed = true;
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      },
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
export type CodexTransport = Awaited<ReturnType<typeof openTransport>>;
