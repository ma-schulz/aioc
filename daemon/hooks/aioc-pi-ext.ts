// Aioc status extension for pi — loaded per invocation via `pi -e <this file>`, reports agent
// state, active tools, and subagent runs to the Aioc daemon. Does not change pi's behavior.
export default function (pi: any) {
  const port = process.env.AIOC_PORT;
  const session = process.env.AIOC_SESSION;
  if (!port || !session) return;

  const post = (event: string, data: Record<string, unknown> = {}) => {
    try {
      fetch(`http://127.0.0.1:${port}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, agent: 'pi', payload: { hook_event_name: event, ...data } }),
      }).catch(() => {});
    } catch { /* never disturb pi */ }
  };

  pi.on('session_start', (_event: any, ctx: any) => {
    let sid: unknown;
    try {
      const sm = ctx?.sessionManager;
      sid = sm?.getSessionId?.() ?? sm?.sessionId ?? sm?.getSessionFile?.() ?? sm?.getSessionPath?.() ?? sm?.sessionFile;
    } catch { /* best effort */ }
    post('SessionStart', { session_id: typeof sid === 'string' ? sid : undefined, cwd: ctx?.cwd });
  });
  pi.on('before_agent_start', (e: any, ctx: any) => {
    post('UserPromptSubmit', { prompt: typeof e?.prompt === 'string' ? e.prompt : undefined, cwd: ctx?.cwd });
  });
  pi.on('agent_start', () => post('UserPromptSubmit'));
  pi.on('tool_execution_start', (e: any, ctx: any) => {
    post('PreToolUse', {
      tool_name: e?.toolName,
      tool_input: e?.args,
      tool_call_id: e?.toolCallId,
      cwd: ctx?.cwd,
    });
  });
  pi.on('tool_execution_update', (e: any) => {
    if (e?.toolName === 'subagent' && e?.partialResult?.details?.results) {
      post('PiSubagentUpdate', {
        mode: e.partialResult.details.mode,
        results: (e.partialResult.details.results as any[]).map(r => ({
          agent: r.agent,
          task: r.task,
          exitCode: r.exitCode,
          model: r.model,
          step: r.step,
        })),
      });
    }
  });
  pi.on('tool_execution_end', (e: any) => {
    if (e?.toolName === 'subagent') {
      const results = e?.result?.details?.results;
      post('PiSubagentEnd', {
        results: Array.isArray(results)
          ? results.map((r: any) => ({ agent: r.agent, task: r.task, exitCode: r.exitCode ?? 0, model: r.model }))
          : [],
      });
    }
  });
  pi.on('agent_settled', () => post('Stop'));
  pi.on('ui_prompt_start', (e: any) => post('PermissionRequest', { prompt: e?.title, kind: e?.kind }));
  pi.on('ui_prompt_end', () => post('UserPromptSubmit'));
  pi.on('session_shutdown', () => post('SessionEnd'));
}
