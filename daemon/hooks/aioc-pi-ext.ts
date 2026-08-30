// Aioc status extension for pi — loaded per invocation via `pi -e <this file>`, reports agent
// state to the Aioc daemon. Does not change pi's behavior in any way.
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
    post('SessionStart', { session_id: typeof sid === 'string' ? sid : undefined });
  });
  pi.on('agent_start', () => post('UserPromptSubmit'));
  pi.on('agent_settled', () => post('Stop'));
  pi.on('ui_prompt_start', (e: any) => post('PermissionRequest', { prompt: e?.title, kind: e?.kind }));
  pi.on('ui_prompt_end', () => post('UserPromptSubmit'));
  pi.on('session_shutdown', () => post('SessionEnd'));
}
