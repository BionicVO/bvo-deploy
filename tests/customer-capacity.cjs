// Run inside the application image with the staging DB and signing key.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
require('reflect-metadata');
const { dataSource } = require('/app/build/src/Infrastructure/Database/PostgresqlConnection');
const { User } = require('/app/build/src/Infrastructure/Database/Models/User');
const { clientSessionService } = require('/app/build/src/Application/Auth/ClientSessionService');
const { JwtService } = require('/app/build/src/Infrastructure/Utils/JwtService');
const { demoWorkspaceService } = require('/app/build/src/Application/Demo/DemoWorkspaceService');
const { BcryptService } = require('/app/build/src/Infrastructure/Utils/BcryptService');
const tags = { standard: 'capacity-api', fallback: 'capacity-lean', early: 'capacity-early' };
const tag = tags[process.env.CAPACITY_TAG || 'standard'];
assert.ok(tag, 'Unknown pre-production tag');
const base = 'https://' + tag + '---bvo-backend-pre-prod-d5ijitzpuq-uc.a.run.app/api/v1';
const userId = 'qa_capacity_' + randomUUID();
const actorId = randomUUID(),
    adminAccountId = randomUUID(),
    adminRoleId = randomUUID();
let session,
    demo,
    granted = false;
async function call(path, token, method = 'GET', body) {
    const res = await fetch(base + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'x-api-token': token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(method + ' ' + path + ' returned ' + res.status);
    return res.json();
}
async function run() {
    assert.equal(process.env.DEMO_STAGING_SMOKE, 'staging-only');
    assert.equal(process.env.DEMO_SMOKE_GENERATE, 'false');
    assert.match(process.env.CLOUD_RUN_JOB || '', /^bvo-capacity-fixture(?:-[a-z0-9-]+)?$/);
    await dataSource.initialize();
    try {
        await dataSource
            .getRepository(User)
            .save({
                userId,
                firstName: 'Capacity',
                lastName: 'QA',
                email: userId + '@demo.invalid',
                status: 'active',
                accountType: 'client',
                isAdmin: false,
            });
        session = await clientSessionService.issue(userId);
        const token = JwtService.createAuthToken({ userId, accountType: 'client' }, session);
        await demoWorkspaceService.grant(userId, true, 'staging-capacity', 'Disposable capacity fixture');
        granted = true;
        demo = await call('/demo/enter', token, 'POST');
        const project = await call('/projects-v2', demo.token, 'POST', {
            name: 'Capacity QA',
            description: 'Disposable staging fixture',
        });
        assert.ok(project.projectId);
        const password = randomUUID() + randomUUID();
        const email = adminAccountId + '@demo.invalid';
        const hash = await BcryptService.encryptPassword(password);
        await dataSource.transaction(async (manager) => {
            const permission = await manager
                .getRepository('AdminPermission')
                .findOneByOrFail({ permissionKey: 'admin.analytics.view' });
            await manager
                .getRepository('AdminAccount')
                .save({ adminAccountId, email, password: hash, status: 'active' });
            await manager
                .getRepository('AdminRole')
                .save({ adminRoleId, roleKey: 'qa_' + adminRoleId, name: 'Capacity QA' });
            await manager
                .getRepository('AdminRolePermission')
                .save({ adminRoleId, adminPermissionId: permission.adminPermissionId });
            await manager.getRepository('AdminAccountRole').save({ adminRoleId, adminAccountId });
            await manager
                .getRepository('Actor')
                .save({
                    actorId,
                    displayName: 'Capacity QA',
                    firstName: 'Capacity',
                    lastName: 'QA',
                    bio: 'Synthetic staging voice',
                    gender: 'other',
                    age: 'adult',
                    phone: '',
                    scriptType: [],
                    voiceType: [],
                    delivery: [],
                    experience: '',
                    projectTypes: [],
                    elVoiceId: 'local_' + actorId,
                });
        });
        const admin = await call('/admin/auth/login', '', 'POST', { email, password });
        assert.deepEqual(admin.permissions, ['admin.analytics.view']);
        const casting = await call('/casting-sessions', demo.token, 'POST', { name: 'Capacity QA' });
        const castingPath = '/casting-sessions/' + encodeURIComponent(casting.castingSessionId);
        await call(castingPath + '/actors', demo.token, 'POST', { actorId });
        const paths = [
            '/projects-v2',
            '/projects-v2/' + encodeURIComponent(project.projectId),
            '/billing/summary',
            '/casting-sessions',
        ];
        const analyticsRange = new URLSearchParams({
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date().toISOString(),
            tz: 'UTC',
        });
        for (const [phase, rps, seconds] of [
            ['steady', 2, 20],
            ['burst', 10, 40],
            ['recovery', 2, 20],
        ]) {
            const auditionStart = performance.now();
            const generated = await call(castingPath + '/auditions', demo.token, 'POST', {
                actorId,
                text: 'Synthetic staging capacity check.',
            });
            assert.ok(generated.audition?.speechId);
            console.log(
                'Synthetic audition ' + phase + ' ' + Math.round(performance.now() - auditionStart) + ' ms',
            );
            const start = performance.now(),
                pending = [];
            let errors = 0;
            for (let i = 0; i < rps * seconds; i++) {
                const due = start + (i * 1000) / rps;
                await sleep(Math.max(0, due - performance.now()));
                const isAnalytics = i % 20 === 0;
                const request = isAnalytics
                    ? call('/admin/analytics/kpis?' + analyticsRange, admin.token)
                    : call(paths[i % paths.length], demo.token);
                pending.push(
                    request
                        .then(() => performance.now() - due)
                        .catch((error) => {
                            if (++errors <= 3) console.error(error.message);
                            return Infinity;
                        }),
                );
            }
            const times = (await Promise.all(pending)).sort((a, b) => a - b);
            const p95 = times[Math.ceil(times.length * 0.95) - 1];
            console.log(
                'CAPACITY ' +
                    JSON.stringify({ phase, rps, count: times.length, errors, p95ms: Math.round(p95) }),
            );
            assert.equal(errors, 0);
            assert.ok(p95 < 2000, 'Customer-flow p95 exceeds two seconds');
        }
    } finally {
        try {
            if (demo) await call('/demo/reset', demo.token, 'POST', { resetKey: randomUUID() });
        } finally {
            try {
                await dataSource.transaction(async (manager) => {
                    await manager.getRepository('AdminAccountRole').delete({ adminRoleId, adminAccountId });
                    await manager.getRepository('AdminRolePermission').delete({ adminRoleId });
                    await manager.getRepository('AdminAccount').delete({ adminAccountId });
                    await manager.getRepository('AdminRole').delete({ adminRoleId });
                    await manager.getRepository('Actor').softDelete({ actorId });
                });
                if (session) await clientSessionService.revoke(session.sessionId);
                if (granted)
                    await demoWorkspaceService.grant(userId, false, 'staging-capacity', 'Fixture ended');
                await dataSource.getRepository(User).update({ userId }, { status: 'inactive' });
            } finally {
                await dataSource.destroy();
            }
        }
    }
}
run().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
