import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export async function launchService(strategy = 'cwm', { caseId = 'P01', scenario = 'disclosure' } = {}) {
  // Explicit environment: model/API credentials are never inherited by the service.
  const child = fork(fileURLToPath(new URL('./agent-service.mjs', import.meta.url)), [], {
    env: { CWM_SERVICE_STRATEGY: strategy, CWM_SERVICE_CASE: caseId, CWM_SERVICE_SCENARIO: scenario }, execArgv: [], silent: true,
  });
  child.stderr.resume();
  child.stdout.resume();
  let connection;
  try {
    connection = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Action service startup timed out')), 10000);
      const failed = () => { clearTimeout(timer); reject(new Error('Action service failed to start')); };
      child.once('error', failed);
      child.once('exit', failed);
      child.once('message', message => {
        clearTimeout(timer); child.off('error', failed); child.off('exit', failed);
        if (!message.ready) reject(new Error('Invalid service startup response'));
        else resolve(message);
      });
    });
  } catch (error) { child.kill(); throw error; }
  const admin = command => new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); };
    const failed = () => { cleanup(); reject(new Error('Action service unavailable')); };
    const receive = message => { if (message.id === id) { cleanup(); resolve(message.data); } };
    const timer = setTimeout(failed, 10000);
    child.on('message', receive); child.once('exit', failed);
    child.send({ id, command }, error => { if (error) failed(); });
  });
  return {
    pid: connection.pid,
    async call(name, args) {
      const response = await fetch(`${connection.url}/tools`, { method: 'POST',
        headers: { Authorization: `Bearer ${connection.credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      const result = await response.json();
      return response.ok ? result : { error: result.error ?? 'service_request_failed', http_status: response.status };
    },
    disclose: () => admin('disclose'), snapshot: () => admin('snapshot'),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.disconnect(); else child.kill();
      });
    },
  };
}
