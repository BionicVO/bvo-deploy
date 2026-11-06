// Staging-only, open-loop replay of the public landing page and DB-backed plan endpoint.
import {setTimeout as sleep} from 'node:timers/promises';
const targets = {
    staging: 'bvo-frontend-staging',
    control: 'bvo-frontend-pre-prod',
    candidate: 'capacity-check---bvo-frontend-pre-prod',
};
const target = process.argv[2] ?? 'staging';
if (!Object.hasOwn(targets, target)) throw new Error('Expected staging, control, or candidate');
const frontend = 'https://' + targets[target] + '-d5ijitzpuq-uc.a.run.app';
const api = 'https://bvo-backend-' + (target === 'staging' ? 'staging' : 'pre-prod') + '-d5ijitzpuq-uc.a.run.app/api/v1';
const landing = await fetch(frontend, {signal: AbortSignal.timeout(30000)});
if (!landing.ok) throw new Error('Staging landing page unavailable');
const html = await landing.text();
const asset = ext => {
    const path = html.match(new RegExp('["\'](/assets/[^"\']+\\.' + ext + ')["\']'))?.[1];
    if (!path) throw new Error('Missing staging ' + ext);
    return frontend + path;
};
const urls = [frontend, asset('js'), asset('css'), frontend+'/env-config.js',
    frontend+'/media/bionicvo-overview-poster.jpg', frontend+'/logo.png', api+'/plans'];
for (const [phase, rps, seconds] of [['baseline', 4, 60], ['spike', 20, 60], ['recovery', 4, 60]]) {
    const start = performance.now();
    const results = [];
    let failures = 0;
    async function request(i) {
        const scheduled = start + i * 1000 / rps;
        const url = urls[i % urls.length];
        try {
            const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(15000)});
            if (!response.ok) throw new Error('HTTP ' + response.status);
            if (url.startsWith(api)) await response.json();
            else await response.arrayBuffer();
            return Math.round(performance.now() - scheduled);
        } catch (error) {
            failures++;
            if (failures <= 3) console.error(new URL(url).pathname, error.message);
            return Infinity;
        }
    }
    const started = new Date().toISOString();
    for (let i = 0; i < rps * seconds; i++) {
        await sleep(Math.max(0, start + i * 1000 / rps - performance.now()));
        if (failures >= 5) break;
        results.push(request(i));
    }
    const latencies = (await Promise.all(results)).sort((a,b) => a-b);
    const p95 = latencies[Math.ceil(0.95 * latencies.length)-1];
    console.log(JSON.stringify({phase, started, rps, seconds, count:results.length, failures, p95ms:p95}));
    if (failures || p95 > 2000) process.exitCode = 1;
    if (failures >= 5) break;
}
