import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockServer } from '../integration/mocks/snow-server.js';
import { createClient } from '../../src/api/index.js';
import { runDoctorChecks } from '../../src/commands/doctor.js';

describe('snbatch doctor', () => {
  let mock;
  let client;
  const creds = { username: 'admin', instanceHost: 'test.service-now.com' };

  afterEach(async () => {
    if (mock) await mock.close();
  });

  describe('all checks pass', () => {
    beforeEach(async () => {
      mock = await createMockServer();
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('returns all passing results', async () => {
      const results = await runDoctorChecks(client, creds);
      const failing = results.filter((r) => !r.pass);
      expect(failing).toHaveLength(0);
    });

    it('checks connectivity', async () => {
      const results = await runDoctorChecks(client, creds);
      const conn = results.find((r) => r.name === 'Connectivity');
      expect(conn.pass).toBe(true);
      expect(conn.detail).toBe('Instance reachable');
    });

    it('checks authentication', async () => {
      const results = await runDoctorChecks(client, creds);
      const auth = results.find((r) => r.name === 'Authentication');
      expect(auth.pass).toBe(true);
      expect(auth.detail).toContain('admin');
    });

    it('checks instance version', async () => {
      const results = await runDoctorChecks(client, creds);
      const ver = results.find((r) => r.name === 'Instance version');
      expect(ver.pass).toBe(true);
      expect(ver.detail).toBe('Yokohama Patch 3');
    });

    it('checks CI/CD REST API plugin', async () => {
      const results = await runDoctorChecks(client, creds);
      const cd = results.find((r) => r.detail?.includes('com.glide.continuousdelivery'));
      expect(cd.pass).toBe(true);
    });

    it('checks App Repo Install API', async () => {
      const results = await runDoctorChecks(client, creds);
      const appRepo = results.find((r) => r.name === 'App Repo Install API');
      expect(appRepo.pass).toBe(true);
      expect(appRepo.detail).toContain('enabled');
    });

    it('checks CI/CD credential alias', async () => {
      const results = await runDoctorChecks(client, creds);
      const alias = results.find((r) => r.name === 'CI/CD Credential Alias');
      expect(alias.pass).toBe(true);
      expect(alias.detail).toContain('configured');
    });

    it('checks CI/CD role', async () => {
      const results = await runDoctorChecks(client, creds);
      const role = results.find((r) => r.name === 'CI/CD Role');
      expect(role.pass).toBe(true);
    });

    it('checks ws_access on tables', async () => {
      const results = await runDoctorChecks(client, creds);
      const wsChecks = results.filter((r) => r.name === 'Web Service Access');
      expect(wsChecks).toHaveLength(4);
      expect(wsChecks.every((r) => r.pass)).toBe(true);
    });

    it('checks for available updates', async () => {
      const results = await runDoctorChecks(client, creds);
      const updates = results.find((r) => r.name === 'Updates available');
      expect(updates.pass).toBe(true);
      expect(updates.detail).toContain('3 store app(s)');
    });
  });

  describe('missing role', () => {
    beforeEach(async () => {
      mock = await createMockServer({ missingRole: true });
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('reports missing CI/CD role as fixable', async () => {
      const results = await runDoctorChecks(client, creds);
      const role = results.find((r) => r.name === 'CI/CD Role');
      expect(role.pass).toBe(false);
      expect(role.detail).toContain('missing');
      expect(role.fixable).toBe(true);
    });
  });

  describe('ws_access disabled', () => {
    beforeEach(async () => {
      mock = await createMockServer({ wsDisabled: ['sys_store_app'] });
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('reports disabled ws_access as fixable', async () => {
      const results = await runDoctorChecks(client, creds);
      const wsChecks = results.filter((r) => r.name === 'Web Service Access');
      const failing = wsChecks.filter((r) => !r.pass);
      expect(failing).toHaveLength(1);
      expect(failing[0].detail).toContain('sys_store_app');
      expect(failing[0].fixable).toBe(true);
    });

    it('passes ws_access check for other tables', async () => {
      const results = await runDoctorChecks(client, creds);
      const wsChecks = results.filter((r) => r.name === 'Web Service Access');
      const passing = wsChecks.filter((r) => r.pass);
      expect(passing).toHaveLength(3); // sys_app_version, sys_plugins, sys_properties
    });
  });

  describe('credential alias missing', () => {
    beforeEach(async () => {
      mock = await createMockServer({ credentialAlias: 'missing' });
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('reports missing alias as not fixable with manual setup flag', async () => {
      const results = await runDoctorChecks(client, creds);
      const alias = results.find((r) => r.name === 'CI/CD Credential Alias');
      expect(alias.pass).toBe(false);
      expect(alias.detail).toContain('not found');
      expect(alias.fixable).toBe(false);
      expect(alias.manualSetup).toBe(true);
    });
  });

  describe('credential alias unconfigured', () => {
    beforeEach(async () => {
      mock = await createMockServer({ credentialAlias: 'unconfigured' });
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('reports unconfigured alias as not fixable with manual setup flag', async () => {
      const results = await runDoctorChecks(client, creds);
      const alias = results.find((r) => r.name === 'CI/CD Credential Alias');
      expect(alias.pass).toBe(false);
      expect(alias.detail).toContain('no credential bound');
      expect(alias.fixable).toBe(false);
      expect(alias.manualSetup).toBe(true);
    });
  });

  describe('app repo install API disabled', () => {
    beforeEach(async () => {
      mock = await createMockServer({ appRepoInstallEnabled: false });
      client = createClient({ baseUrl: mock.baseUrl, username: 'admin', password: 'test' });
    });

    it('reports disabled app repo install API as fixable', async () => {
      const results = await runDoctorChecks(client, creds);
      const appRepo = results.find((r) => r.name === 'App Repo Install API');
      expect(appRepo.pass).toBe(false);
      expect(appRepo.detail).toContain('false');
      expect(appRepo.fixable).toBe(true);
    });
  });

  describe('connectivity failure', () => {
    it('stops early when instance is unreachable', async () => {
      // Client pointing to a port nothing is listening on — no mock needed
      mock = null;
      client = createClient({ baseUrl: 'http://127.0.0.1:1', username: 'admin', password: 'test' });
      const results = await runDoctorChecks(client, creds);
      expect(results[0].name).toBe('Connectivity');
      expect(results[0].pass).toBe(false);
      // Should only have the connectivity check since it bails early
      expect(results).toHaveLength(1);
    });
  });
});
