import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
const tags = { backend: 'capacity-api', 'backend-lean': 'capacity-lean', 'backend-early': 'capacity-early' };
const tag = tags[__ENV.CONFIG || 'backend'];
if (!tag) throw new Error('Unknown pre-production configuration');
const base = 'https://' + tag + '---bvo-backend-pre-prod-d5ijitzpuq-uc.a.run.app/api/v1';
const invalid = new Rate('unexpected_response');
export const options = {
    discardResponseBodies: true,
    scenarios: {
        publicApi: {
            executor: 'ramping-arrival-rate',
            startRate: 5,
            timeUnit: '1s',
            preAllocatedVUs: 1500,
            maxVUs: 2000,
            stages: [
                { target: 15, duration: '30s' },
                { target: 15, duration: '30s' },
                { target: 150, duration: '10s' },
                { target: 150, duration: '60s' },
                { target: 5, duration: '10s' },
                { target: 5, duration: '60s' },
            ],
        },
    },
    thresholds: {
        http_req_failed: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '20s' }, 'rate==0'],
        unexpected_response: ['rate==0'],
        dropped_iterations: ['count==0'],
        http_req_duration: ['p(95)<2000'],
    },
};
export function setup() {
    const roster = http.get(base + '/actors', { responseType: 'text' });
    if (roster.status !== 200) throw new Error('Pre-production roster unavailable');
    const avatars = [];
    for (const actor of roster.json('rows')) {
        if (!actor.avatarUrl) continue;
        const path = '/actors/' + encodeURIComponent(actor.actorId) + '/avatar';
        const sample = http.get(base + path, { redirects: 0 });
        if ([200, 302, 307].includes(sample.status)) avatars.push(path);
        if (avatars.length === 8) break;
    }
    if (!avatars.length) throw new Error('Missing test avatars');
    return avatars;
}
export default function (avatars) {
    const i = __ITER + __VU;
    const slot = i % 20;
    const path = slot < 9 ? '/actors' : slot === 9 ? '/plans' : avatars[i % avatars.length];
    const res = http.get(base + path, {
        redirects: 0,
        timeout: '30s',
        tags: { name: path.includes('/avatar') ? 'avatar' : path },
    });
    invalid.add(
        !check(res, {
            'valid API response': (r) =>
                r.status === 200 || (path.includes('/avatar') && [302, 307].includes(r.status)),
        }),
    );
}
