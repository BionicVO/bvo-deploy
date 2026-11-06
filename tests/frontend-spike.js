import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
const invalid = new Rate('unexpected_response');
const tags = {control:'capacity-control', candidate:'capacity-spike', memory:'capacity-memory'};
const tag = tags[__ENV.CONFIG || 'candidate'];
if (!tag) throw new Error('Unknown pre-production configuration');
const frontend = 'https://' + tag + '---bvo-frontend-pre-prod-d5ijitzpuq-uc.a.run.app';
export const options = {
    discardResponseBodies: true,
    scenarios: {
        landing: {
            executor: 'ramping-arrival-rate', startRate: 10, timeUnit: '1s',
            preAllocatedVUs: 1200, maxVUs: 1500,
            stages: [
                {target: 50, duration: '30s'}, {target: 50, duration: '30s'},
                {target: 530, duration: '10s'}, {target: 530, duration: '60s'},
                {target: 10, duration: '10s'}, {target: 10, duration: '60s'},
            ],
        },
    },
    thresholds: {
        http_req_failed: ['rate==0'], unexpected_response: ['rate==0'],
        dropped_iterations: ['count==0'], http_req_duration: ['p(95)<2000'],
    },
};
export function setup() {
    const res = http.get(frontend, {responseType: 'text'});
    if (res.status !== 200) throw new Error('Missing pre-production landing page');
    const asset = ext => {
        const match = res.body.match(new RegExp('["\'](/assets/[^"\']+\\.' + ext + ')["\']'));
        if (!match) throw new Error('Missing ' + ext);
        return match[1];
    };
    return ['/', '/', '/', '/env-config.js', '/env-config.js', '/logo.png',
        '/media/bionicvo-overview-poster.jpg', '/media/bionicvo-overview.webm',
        asset('js'), asset('css'), '/favicon.ico'];
}
export default function (paths) {
    const path = paths[(__VU + __ITER) % paths.length];
    const video = path.endsWith('webm');
    const res = http.get(frontend + path, {timeout:'10s', headers:video ? {Range:'bytes=0-65535'} : {}});
    invalid.add(!check(res, {'asset served': r => r.status === (video ? 206 : 200)}));
}
