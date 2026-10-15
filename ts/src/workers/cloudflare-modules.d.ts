/**
 * Minimal declarations of the two runtime modules the edge entry point
 * imports, so it type-checks in this repository, where neither
 * `@cloudflare/workers-types` nor `@cloudflare/sandbox` is installed and
 * there is no network. **Unverified against the real packages**: after
 * `npm install` and `wrangler types`, delete this file and use the generated
 * / published types; any mismatch shows up there and is confined to
 * `edge.ts`.
 *
 * Shapes taken from the Cloudflare Workflows and Sandbox SDK documentation
 * as described in the task: `WorkflowEntrypoint<Env, Params>` with
 * `run(event, step)`, `step.do(name, fn)`, `env.<WORKFLOW>.create({ id, params })`;
 * `getSandbox(namespace, id)` returning an object with `exec`, `writeFile`,
 * `readFile`, `destroy`.
 */
declare module "cloudflare:workers" {
  export interface WorkflowEvent<P> {
    readonly payload: Readonly<P>
    readonly timestamp: Date
    readonly instanceId: string
  }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>
    sleep(name: string, duration: string | number): Promise<void>
  }
  export abstract class WorkflowEntrypoint<Env = unknown, P = unknown> {
    protected readonly ctx: unknown
    protected readonly env: Env
    constructor(ctx: unknown, env: Env)
    abstract run(event: Readonly<WorkflowEvent<P>>, step: WorkflowStep): Promise<unknown>
  }
}

declare module "@cloudflare/sandbox" {
  export interface ExecResult {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
    readonly success?: boolean
  }
  export interface SandboxStub {
    exec(command: string, options?: { readonly cwd?: string; readonly env?: Record<string, string>; readonly timeout?: number }): Promise<ExecResult>
    writeFile(path: string, content: string, options?: { readonly encoding?: string }): Promise<unknown>
    readFile(path: string, options?: { readonly encoding?: string }): Promise<{ readonly content: string }>
    destroy(): Promise<unknown>
  }
  export class Sandbox {}
  export function getSandbox(namespace: unknown, id: string): SandboxStub
}
