const crypto = require('crypto');
const { compareVersions, computeHealthScore, isInRollout, errorSignature, normalizeFleetProductFamily } = require('./fleet_logic');

function intId(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function asObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {}
  }
  return fallback;
}

function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {}
  }
  return fallback;
}

function parseBool(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function registerFleetRoutes({
  app,
  pool,
  validateAdminAuth,
  validateClientToken,
  requirePermission,
  requireRole,
  publicError,
  serverError,
  queueSignedCommand,
  normalizeProductFamily,
  normalizeLicenseStatus,
}) {
  app.get('/api/v1/fleet/overview', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const [clients, installs, alerts, commands, backups, errors, deployments] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE LOWER(status) IN ('active','trial'))::int active,
          COUNT(*) FILTER (WHERE product_family='PUBLIC')::int public,
          COUNT(*) FILTER (WHERE product_family='COMMERCIAL')::int commercial FROM cc_clients`),
        pool.query(`SELECT COUNT(*)::int total,
          COUNT(*) FILTER (WHERE connected=1)::int online,
          COUNT(*) FILTER (WHERE health_score < 70)::int unhealthy,
          COUNT(*) FILTER (WHERE maintenance_mode=1)::int maintenance,
          COALESCE(ROUND(AVG(health_score)),0)::int avg_health FROM cc_installations`),
        pool.query(`SELECT COUNT(*)::int count FROM cc_alerts WHERE LOWER(status) IN ('activa','active','open')`),
        pool.query(`SELECT COUNT(*)::int count FROM cc_commands WHERE status='pending' AND expires_at::timestamptz > NOW()`),
        pool.query(`SELECT COUNT(*) FILTER (WHERE COALESCE(last_run,'')<>'' AND last_run::timestamptz >= NOW()-INTERVAL '24 hours')::int fresh,
          COUNT(*)::int total FROM cc_backups`),
        pool.query(`SELECT COUNT(*)::int groups, COALESCE(SUM(occurrences),0)::bigint occurrences FROM cc_error_groups WHERE last_seen >= NOW()-INTERVAL '7 days'`),
        pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('running','queued'))::int active,
          COUNT(*) FILTER (WHERE status='failed')::int failed FROM cc_deployments`),
      ]);
      return res.json({ success: true, overview: {
        clients: clients.rows[0], installations: installs.rows[0], active_alerts: alerts.rows[0].count,
        pending_commands: commands.rows[0].count, backups: backups.rows[0], errors_7d: errors.rows[0], deployments: deployments.rows[0],
      }});
    } catch (error) { return serverError(res, 'Fleet overview failed', error); }
  });

  app.get('/api/v1/search', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return publicError(res, 400, 'Search query must contain at least 2 characters');
      const like = `%${q}%`;
      const [clients, installations, licenses, tickets] = await Promise.all([
        pool.query(`SELECT id,name,nit,status,product_family FROM cc_clients WHERE name ILIKE $1 OR COALESCE(nit,'') ILIKE $1 OR COALESCE(contact_email,'') ILIKE $1 ORDER BY id DESC LIMIT 10`, [like]),
        pool.query(`SELECT id,uuid,client_id,company_name,version,connected,health_score FROM cc_installations WHERE uuid ILIKE $1 OR COALESCE(company_name,'') ILIKE $1 OR COALESCE(tax_id,'') ILIKE $1 ORDER BY id DESC LIMIT 10`, [like]),
        pool.query(`SELECT id,client_id,type,status,product_family,expires_at FROM cc_licenses WHERE CAST(id AS TEXT)=$2 OR type ILIKE $1 ORDER BY id DESC LIMIT 10`, [like, q]),
        pool.query(`SELECT id,client_id,title,status,priority FROM cc_tickets WHERE title ILIKE $1 OR CAST(id AS TEXT)=$2 ORDER BY id DESC LIMIT 10`, [like, q]),
      ]);
      return res.json({ success: true, results: { clients: clients.rows, installations: installations.rows, licenses: licenses.rows, tickets: tickets.rows } });
    } catch (error) { return serverError(res, 'Global search failed', error); }
  });

  app.get('/api/v1/installations/:uuid/health', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM cc_installations WHERE uuid=$1 LIMIT 1`, [req.params.uuid]);
      const inst = result.rows[0];
      if (!inst) return publicError(res, 404, 'Installation not found');
      const computed = computeHealthScore({
        connected: inst.connected, criticalErrors: inst.critical_errors, freeDiskMb: inst.free_disk_mb,
        databaseStatus: inst.database_status, syncStatus: inst.sync_status, lastBackupAt: inst.last_backup_at,
      });
      if (Number(inst.health_score) !== computed.score) {
        await pool.query(`UPDATE cc_installations SET health_score=$1 WHERE uuid=$2`, [computed.score, inst.uuid]);
      }
      const history = await pool.query(`SELECT health_score,health_status,summary_json,created_at FROM cc_health_checks WHERE installation_uuid=$1 ORDER BY created_at DESC LIMIT 30`, [inst.uuid]);
      return res.json({ success: true, health: computed, installation: { ...inst, command_secret: undefined }, history: history.rows });
    } catch (error) { return serverError(res, 'Installation health failed', error); }
  });

  app.post('/api/v1/installations/:uuid/diagnostics', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    let runId = null;
    try {
      const checks = Array.isArray(req.body?.checks) ? req.body.checks.map(String).slice(0, 50) : [
        'database_integrity','migrations','sync_engine','disk_space','permissions','backup_state','license_state','update_state',
      ];
      const inserted = await pool.query(`INSERT INTO cc_diagnostic_runs(installation_uuid,requested_by,status,checks_json) VALUES($1,$2,'pending',$3) RETURNING id`, [req.params.uuid, req.user.username, JSON.stringify(checks)]);
      runId = inserted.rows[0].id;
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: 'run_diagnostics', params: { diagnostic_run_id: String(runId), checks }, priority: 'alta', title: 'Diagnostico integral', executedBy: req.user.username });
      await pool.query(`UPDATE cc_diagnostic_runs SET command_id=$1 WHERE id=$2`, [Number(command.id), runId]);
      return res.status(201).json({ success: true, diagnostic_run_id: runId, command });
    } catch (error) {
      if (runId) await pool.query(`UPDATE cc_diagnostic_runs SET status='failed',result_json=$1,completed_at=NOW() WHERE id=$2`, [JSON.stringify({ error: error.message }), runId]).catch(() => {});
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Diagnostic request failed', error);
    }
  });

  app.get('/api/v1/installations/:uuid/diagnostics', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM cc_diagnostic_runs WHERE installation_uuid=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.uuid]);
      return res.json({ success: true, diagnostics: result.rows });
    } catch (error) { return serverError(res, 'Diagnostics history failed', error); }
  });

  app.get('/api/v1/repairs/catalog', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const family = req.query.product_family ? normalizeFleetProductFamily(req.query.product_family) : null;
      const result = family && family !== 'ALL'
        ? await pool.query(`SELECT * FROM cc_repair_catalog WHERE enabled=1 AND product_family IN ('ALL',$1) ORDER BY risk_level,code`, [family])
        : await pool.query(`SELECT * FROM cc_repair_catalog WHERE enabled=1 ORDER BY product_family,risk_level,code`);
      return res.json({ success: true, repairs: result.rows });
    } catch (error) { return serverError(res, 'Repair catalog failed', error); }
  });

  app.post('/api/v1/installations/:uuid/repairs/:code', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    try {
      const repair = (await pool.query(`SELECT * FROM cc_repair_catalog WHERE code=$1 AND enabled=1`, [String(req.params.code).toUpperCase()])).rows[0];
      if (!repair) return publicError(res, 404, 'Repair not found or disabled');
      const inst = (await pool.query(`SELECT i.*,c.product_family FROM cc_installations i JOIN cc_clients c ON c.id=i.client_id WHERE i.uuid=$1`, [req.params.uuid])).rows[0];
      if (!inst) return publicError(res, 404, 'Installation not found');
      if (repair.product_family !== 'ALL' && repair.product_family !== inst.product_family) return publicError(res, 409, 'Repair is not compatible with this product family');
      const defaults = asObject(repair.default_params_json);
      const params = { ...defaults, ...asObject(req.body?.params), repair_code: repair.code };
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: repair.command_action, params, priority: repair.risk_level === 'high' ? 'critica' : 'alta', title: repair.title, executedBy: req.user.username });
      const run = await pool.query(`INSERT INTO cc_repair_runs(installation_uuid,repair_code,command_id,status,requested_by) VALUES($1,$2,$3,'pending',$4) RETURNING id`, [req.params.uuid, repair.code, Number(command.id), req.user.username]);
      return res.status(201).json({ success: true, repair_run_id: run.rows[0].id, command });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Repair request failed', error);
    }
  });

  app.post('/api/v1/installations/:uuid/maintenance', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    try {
      const enabled = parseBool(req.body?.enabled);
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: enabled ? 'entrar_mantenimiento' : 'salir_mantenimiento', params: { reason: String(req.body?.reason || 'Operacion administrativa').slice(0,500) }, priority: 'alta', title: enabled ? 'Entrar en mantenimiento' : 'Salir de mantenimiento', executedBy: req.user.username });
      const updated = await pool.query(`UPDATE cc_installations SET maintenance_mode=$1,updated_at=NOW() WHERE uuid=$2 RETURNING uuid,maintenance_mode`, [enabled ? 1 : 0, req.params.uuid]);
      if (!updated.rows[0]) return publicError(res, 404, 'Installation not found');
      return res.json({ success: true, installation: updated.rows[0], command });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Maintenance mode failed', error);
    }
  });

  app.put('/api/v1/installations/:uuid/config', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    try {
      const config = asObject(req.body?.config);
      const version = Number.parseInt(String(req.body?.version || Date.now()), 10);
      if (Buffer.byteLength(JSON.stringify(config)) > 64 * 1024) return publicError(res, 413, 'Remote configuration exceeds 64 KiB');
      await pool.query(`INSERT INTO cc_remote_configs(scope_type,scope_id,config_json,version,active,updated_by,updated_at)
        VALUES('installation',$1,$2,$3,1,$4,NOW()) ON CONFLICT(scope_type,scope_id) DO UPDATE SET config_json=EXCLUDED.config_json,version=EXCLUDED.version,active=1,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [req.params.uuid, JSON.stringify(config), version, req.user.username]);
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: 'aplicar_configuracion', params: { version, config }, priority: 'alta', title: 'Aplicar configuración remota', executedBy: req.user.username });
      return res.json({ success: true, version, command });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Remote configuration failed', error);
    }
  });

  app.get('/api/v1/service-status', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const rows = await pool.query(`SELECT * FROM cc_service_status ORDER BY service_name`);
      return res.json({ success: true, services: rows.rows });
    } catch (error) { return serverError(res, 'Service status failed', error); }
  });

  app.put('/api/v1/service-status/:name', validateAdminAuth, requireRole('admin'), async (req, res) => {
    try {
      const name = String(req.params.name || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{2,80}$/.test(name)) return publicError(res, 400, 'Invalid service name');
      const status = String(req.body?.status || '').trim().toLowerCase();
      if (!['operational','degraded','maintenance','outage'].includes(status)) return publicError(res, 400, 'Invalid service status');
      const message = String(req.body?.message || '').trim().slice(0, 1000) || null;
      const row = await pool.query(
        `INSERT INTO cc_service_status(service_name,status,message,updated_at) VALUES($1,$2,$3,NOW())
         ON CONFLICT(service_name) DO UPDATE SET status=EXCLUDED.status,message=EXCLUDED.message,updated_at=NOW() RETURNING *`,
        [name, status, message],
      );
      return res.json({ success: true, service: row.rows[0] });
    } catch (error) { return serverError(res, 'Service status update failed', error); }
  });

  app.get('/api/v1/clients/:id/policy', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid client id');
      const row = (await pool.query(`SELECT id,product_family,support_policy_json FROM cc_clients WHERE id=$1`, [id])).rows[0];
      if (!row) return publicError(res, 404, 'Client not found');
      return res.json({ success: true, client_id: id, product_family: row.product_family, policy: asObject(row.support_policy_json) });
    } catch (error) { return serverError(res, 'Client policy failed', error); }
  });

  app.put('/api/v1/clients/:id/policy', validateAdminAuth, requireRole('admin'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid client id');
      const policy = asObject(req.body?.policy);
      const result = await pool.query(`UPDATE cc_clients SET support_policy_json=$1,updated_at=NOW() WHERE id=$2 RETURNING id`, [JSON.stringify(policy), id]);
      if (!result.rows[0]) return publicError(res, 404, 'Client not found');
      const installs = await pool.query(`SELECT uuid FROM cc_installations WHERE client_id=$1 AND COALESCE(blocked,0)=0 LIMIT 200`, [id]);
      for (const row of installs.rows) {
        await queueSignedCommand({ installationUuid: row.uuid, action: 'aplicar_configuracion', params: { refresh_policy: true }, priority: 'info', title: 'Actualizar política de soporte', executedBy: req.user.username }).catch(() => {});
      }
      return res.json({ success: true, client_id: id, policy });
    } catch (error) { return serverError(res, 'Client policy update failed', error); }
  });

  app.get('/api/v1/installations/:uuid/policy', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const row = (await pool.query(`SELECT uuid,policy_json,update_channel,maintenance_mode FROM cc_installations WHERE uuid=$1`, [req.params.uuid])).rows[0];
      if (!row) return publicError(res, 404, 'Installation not found');
      return res.json({ success: true, installation_uuid: row.uuid, update_channel: row.update_channel, maintenance_mode: row.maintenance_mode, policy: asObject(row.policy_json) });
    } catch (error) { return serverError(res, 'Installation policy failed', error); }
  });

  app.put('/api/v1/installations/:uuid/policy', validateAdminAuth, requireRole('admin'), async (req, res) => {
    try {
      const policy = asObject(req.body?.policy);
      const channel = String(req.body?.update_channel || '').trim().toLowerCase();
      const allowedChannels = new Set(['development','internal','beta','rc','stable','lts','hotfix']);
      if (channel && !allowedChannels.has(channel)) return publicError(res, 400, 'Invalid update channel');
      const result = await pool.query(
        `UPDATE cc_installations SET policy_json=$1,update_channel=CASE WHEN $2='' THEN update_channel ELSE $2 END,updated_at=NOW() WHERE uuid=$3 RETURNING uuid,policy_json,update_channel`,
        [JSON.stringify(policy), channel, req.params.uuid],
      );
      if (!result.rows[0]) return publicError(res, 404, 'Installation not found');
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: 'aplicar_configuracion', params: { policy, update_channel: result.rows[0].update_channel }, priority: 'alta', title: 'Aplicar política de instalación', executedBy: req.user.username });
      return res.json({ success: true, installation: result.rows[0], command });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Installation policy update failed', error);
    }
  });

  app.get('/api/v1/feature-flags', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const flags = await pool.query(`SELECT * FROM cc_feature_flags ORDER BY flag_key`);
      const overrides = await pool.query(`SELECT * FROM cc_feature_flag_overrides ORDER BY flag_key,scope_type,scope_id`);
      return res.json({ success: true, flags: flags.rows, overrides: overrides.rows });
    } catch (error) { return serverError(res, 'Feature flags failed', error); }
  });

  app.put('/api/v1/feature-flags/:key', validateAdminAuth, requireRole('admin'), async (req, res) => {
    try {
      const key = String(req.params.key).trim().toLowerCase();
      if (!/^[a-z0-9_.-]{2,120}$/.test(key)) return publicError(res, 400, 'Invalid feature flag key');
      const description = String(req.body?.description || key).slice(0,1000);
      const defaultEnabled = parseBool(req.body?.default_enabled);
      const family = normalizeFleetProductFamily(req.body?.product_family);
      const result = await pool.query(`INSERT INTO cc_feature_flags(flag_key,description,default_enabled,product_family,min_version,max_version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(flag_key) DO UPDATE SET description=EXCLUDED.description,default_enabled=EXCLUDED.default_enabled,product_family=EXCLUDED.product_family,min_version=EXCLUDED.min_version,max_version=EXCLUDED.max_version,updated_at=NOW() RETURNING *`,
        [key, description, defaultEnabled ? 1 : 0, family, req.body?.min_version || null, req.body?.max_version || null]);
      return res.json({ success: true, flag: result.rows[0] });
    } catch (error) { return serverError(res, 'Feature flag update failed', error); }
  });

  app.put('/api/v1/feature-flags/:key/override', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    try {
      const key = String(req.params.key).trim().toLowerCase();
      const scopeType = String(req.body?.scope_type || '').toLowerCase();
      const scopeId = String(req.body?.scope_id || '').trim();
      if (!['client','installation'].includes(scopeType) || !scopeId) return publicError(res, 400, 'scope_type client/installation and scope_id are required');
      const enabled = parseBool(req.body?.enabled);
      await pool.query(`INSERT INTO cc_feature_flag_overrides(flag_key,scope_type,scope_id,enabled,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(flag_key,scope_type,scope_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [key,scopeType,scopeId,enabled?1:0,req.user.username]);
      if (scopeType === 'installation') {
        await queueSignedCommand({ installationUuid: scopeId, action: 'aplicar_feature_flags', params: { refresh: true }, priority: 'alta', title: 'Actualizar feature flags', executedBy: req.user.username });
      } else {
        const installs = await pool.query(`SELECT uuid FROM cc_installations WHERE client_id=$1 AND COALESCE(blocked,0)=0`, [intId(scopeId)]);
        for (const row of installs.rows.slice(0,200)) {
          await queueSignedCommand({ installationUuid: row.uuid, action: 'aplicar_feature_flags', params: { refresh: true }, priority: 'info', title: 'Actualizar feature flags', executedBy: req.user.username }).catch(() => {});
        }
      }
      return res.json({ success: true, flag_key: key, scope_type: scopeType, scope_id: scopeId, enabled });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Feature flag override failed', error);
    }
  });

  app.post('/api/v1/installations/:uuid/message', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim().slice(0,200);
      const body = String(req.body?.body || '').trim().slice(0,5000);
      const severity = String(req.body?.severity || 'info').toLowerCase();
      if (!title || !body) return publicError(res, 400, 'title and body are required');
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: 'mensaje_admin', params: { titulo: title, mensaje: body, severity }, priority: severity === 'critical' ? 'critica' : 'info', title, executedBy: req.user.username });
      const stored = await pool.query(`INSERT INTO cc_messages(scope_type,scope_id,title,body,severity,status,created_by,expires_at) VALUES('installation',$1,$2,$3,$4,'queued',$5,$6) RETURNING id`, [req.params.uuid,title,body,severity,req.user.username,req.body?.expires_at || null]);
      return res.status(201).json({ success: true, message_id: stored.rows[0].id, command });
    } catch (error) {
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Message delivery failed', error);
    }
  });

  app.post('/api/v1/installations/:uuid/backups', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    let backupId = null;
    try {
      const inst = (await pool.query(`SELECT uuid,client_id FROM cc_installations WHERE uuid=$1`, [req.params.uuid])).rows[0];
      if (!inst) return publicError(res, 404, 'Installation not found');
      const backup = await pool.query(`INSERT INTO cc_backups(client_id,installation_uuid,status,size_mb,last_run,requested_by,created_at,retention_until) VALUES($1,$2,'pending',0,$3,$4,NOW(),$5) RETURNING id`, [inst.client_id,inst.uuid,new Date().toISOString(),req.user.username,req.body?.retention_until || null]);
      backupId = backup.rows[0].id;
      const command = await queueSignedCommand({ installationUuid: inst.uuid, action: 'forzar_respaldo', params: { backup_id: String(backupId), reason: String(req.body?.reason || 'Backup remoto') }, priority: 'alta', title: 'Crear respaldo', executedBy: req.user.username });
      return res.status(201).json({ success: true, backup_id: backupId, command });
    } catch (error) {
      if (backupId) await pool.query(`UPDATE cc_backups SET status='failed' WHERE id=$1`, [backupId]).catch(() => {});
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Backup request failed', error);
    }
  });

  app.get('/api/v1/installations/:uuid/backups', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM cc_backups WHERE installation_uuid=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [req.params.uuid]);
      return res.json({ success: true, backups: result.rows });
    } catch (error) { return serverError(res, 'Backup history failed', error); }
  });

  app.post('/api/v1/installations/:uuid/restores', validateAdminAuth, requireRole('admin'), async (req, res) => {
    let restoreId = null;
    try {
      const backupId = intId(req.body?.backup_id);
      if (!backupId) return publicError(res, 400, 'backup_id is required');
      const backup = (await pool.query(`SELECT b.*,i.client_id installation_client_id FROM cc_backups b JOIN cc_installations i ON i.uuid=$1 WHERE b.id=$2`, [req.params.uuid, backupId])).rows[0];
      if (!backup || Number(backup.client_id) !== Number(backup.installation_client_id)) return publicError(res, 409, 'Backup does not belong to this client');
      const run = await pool.query(`INSERT INTO cc_restore_jobs(installation_uuid,backup_id,status,requested_by,reason) VALUES($1,$2,'pending',$3,$4) RETURNING id`, [req.params.uuid,backupId,req.user.username,String(req.body?.reason || 'Restauracion autorizada').slice(0,1000)]);
      restoreId = run.rows[0].id;
      const command = await queueSignedCommand({ installationUuid: req.params.uuid, action: 'restaurar_respaldo', params: { restore_job_id: String(restoreId), backup_id: String(backupId), backup_ref: backup.backup_ref, checksum: backup.checksum }, priority: 'critica', title: 'Restaurar respaldo', executedBy: req.user.username });
      await pool.query(`UPDATE cc_restore_jobs SET command_id=$1 WHERE id=$2`, [Number(command.id),restoreId]);
      return res.status(201).json({ success: true, restore_job_id: restoreId, command });
    } catch (error) {
      if (restoreId) await pool.query(`UPDATE cc_restore_jobs SET status='failed',result_json=$1,completed_at=NOW() WHERE id=$2`, [JSON.stringify({error:error.message}),restoreId]).catch(()=>{});
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Restore request failed', error);
    }
  });

  app.get('/api/v1/updates/:id/compatibility', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid release id');
      const release = (await pool.query(`SELECT * FROM cc_releases WHERE id=$1`, [id])).rows[0];
      if (!release) return publicError(res, 404, 'Release not found');
      const targetFamily = normalizeFleetProductFamily(release.product_family || 'ALL');
      const supportedOs = asArray(release.supported_os_json).map((v) => String(v).toLowerCase());
      const supportedArch = asArray(release.supported_arch_json).map((v) => String(v).toLowerCase());
      const rows = await pool.query(`SELECT i.uuid,i.version,i.os,i.architecture,i.free_disk_mb,i.blocked,c.product_family FROM cc_installations i JOIN cc_clients c ON c.id=i.client_id ORDER BY i.id`);
      const targets = rows.rows.map((row) => {
        const reasons = [];
        if (Number(row.blocked || 0) === 1) reasons.push('blocked');
        if (targetFamily !== 'ALL' && normalizeFleetProductFamily(row.product_family) !== targetFamily) reasons.push('product_family');
        if (release.min_client_version && compareVersions(row.version || '0.0.0', release.min_client_version) < 0) reasons.push('min_client_version');
        if (row.free_disk_mb != null && Number(row.free_disk_mb) < Number(release.min_free_mb || 0)) reasons.push('disk_space');
        if (supportedOs.length && !supportedOs.some((value) => String(row.os || '').toLowerCase().includes(value))) reasons.push('os');
        if (supportedArch.length && !supportedArch.includes(String(row.architecture || '').toLowerCase())) reasons.push('architecture');
        if (!isInRollout(row.uuid, id, release.rollout_pct ?? 100)) reasons.push('rollout_bucket');
        return { ...row, eligible: reasons.length === 0, reasons };
      });
      const eligible = targets.filter((row) => row.eligible).length;
      return res.json({ success: true, release_id: id, total: targets.length, eligible, excluded: targets.length - eligible, targets });
    } catch (error) { return serverError(res, 'Release compatibility failed', error); }
  });

  app.get('/api/v1/deployments', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const rows = await pool.query(`SELECT d.*,r.version,r.channel,r.product_family release_product_family,r.release_type,r.rollback_version FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id ORDER BY d.created_at DESC LIMIT 200`);
      return res.json({ success: true, deployments: rows.rows });
    } catch (error) { return serverError(res, 'Deployments list failed', error); }
  });

  app.post('/api/v1/deployments', validateAdminAuth, requireRole('admin'), async (req, res) => {
    const tx = await pool.connect();
    try {
      const releaseId = intId(req.body?.release_id);
      if (!releaseId) return publicError(res, 400, 'release_id is required');
      const release = (await tx.query(`SELECT * FROM cc_releases WHERE id=$1 AND status='published'`, [releaseId])).rows[0];
      if (!release) return publicError(res, 404, 'Published release not found');
      const scopeType = String(req.body?.scope_type || 'all').toLowerCase();
      const scopeId = req.body?.scope_id == null ? null : String(req.body.scope_id);
      if (!['all','client','installation'].includes(scopeType)) return publicError(res, 400, 'Invalid deployment scope');
      const family = normalizeFleetProductFamily(req.body?.product_family || release.product_family || 'ALL');
      const strategy = String(req.body?.strategy || 'manual').toLowerCase();
      if (!['manual','immediate','canary','scheduled'].includes(strategy)) return publicError(res,400,'Invalid deployment strategy');
      const rolloutPct = Math.max(0,Math.min(100,Number(release.rollout_pct || 100)));
      const batchPct = Math.max(1,Math.min(100,Number(req.body?.batch_pct || (strategy === 'canary' ? 10 : 100))));
      const errorThresholdPct = Math.max(1,Math.min(100,Number(req.body?.error_threshold_pct || 20)));
      const autoRollback = req.body?.auto_rollback === true || Number(req.body?.auto_rollback || 0) === 1;
      const scheduledAtRaw = req.body?.scheduled_at == null ? null : String(req.body.scheduled_at).trim();
      const scheduledAt = scheduledAtRaw && !Number.isNaN(Date.parse(scheduledAtRaw)) ? new Date(scheduledAtRaw).toISOString() : null;
      if (strategy === 'scheduled' && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) return publicError(res,400,'scheduled strategy requires scheduled_at in the future');
      const params=[]; const where=[`COALESCE(i.blocked,0)=0`];
      if (family !== 'ALL') { params.push(family); where.push(`c.product_family=$${params.length}`); }
      if (scopeType==='client') { const cid=intId(scopeId); if(!cid)return publicError(res,400,'Invalid client scope'); params.push(cid); where.push(`i.client_id=$${params.length}`); }
      if (scopeType==='installation') { params.push(scopeId); where.push(`i.uuid=$${params.length}`); }
      const targets = await tx.query(`SELECT i.uuid,i.free_disk_mb,i.version,i.os,i.architecture FROM cc_installations i JOIN cc_clients c ON c.id=i.client_id WHERE ${where.join(' AND ')} ORDER BY i.id`, params);
      const supportedOs = asArray(release.supported_os_json).map((v) => String(v).toLowerCase());
      const supportedArch = asArray(release.supported_arch_json).map((v) => String(v).toLowerCase());
      const eligible = targets.rows.filter((row) => {
        if (row.free_disk_mb != null && Number(row.free_disk_mb) < Number(release.min_free_mb || 0)) return false;
        if (release.min_client_version && compareVersions(row.version || '0.0.0', release.min_client_version) < 0) return false;
        if (supportedOs.length && !supportedOs.some((value) => String(row.os || '').toLowerCase().includes(value))) return false;
        if (supportedArch.length && !supportedArch.includes(String(row.architecture || '').toLowerCase())) return false;
        return isInRollout(row.uuid, releaseId, rolloutPct);
      }).slice(0,1000);
      await tx.query('BEGIN');
      const dep = await tx.query(`INSERT INTO cc_deployments(release_id,name,scope_type,scope_id,product_family,strategy,status,target_count,created_by,batch_pct,error_threshold_pct,scheduled_at,auto_rollback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [releaseId,String(req.body?.name||`Deploy ${release.version}`).slice(0,300),scopeType,scopeId,family,strategy,strategy==='immediate'?'queued':'draft',eligible.length,req.user.username,batchPct,errorThresholdPct,scheduledAt,autoRollback?1:0]);
      for (const row of eligible) await tx.query(`INSERT INTO cc_deployment_targets(deployment_id,installation_uuid,status,previous_version) VALUES($1,$2,'pending',$3) ON CONFLICT DO NOTHING`,[dep.rows[0].id,row.uuid,row.version||null]);
      await tx.query('COMMIT');
      return res.status(201).json({ success:true,deployment:dep.rows[0],eligible_targets:eligible.length });
    } catch(error){ await tx.query('ROLLBACK').catch(()=>{}); return serverError(res,'Create deployment failed',error); } finally { tx.release(); }
  });

  app.post('/api/v1/deployments/:id/start', validateAdminAuth, requireRole('admin'), async (req,res)=>{
    try{
      const id=intId(req.params.id); if(!id)return publicError(res,400,'Invalid deployment id');
      const dep=(await pool.query(`SELECT d.*,r.version,r.release_type,r.rollback_version FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id WHERE d.id=$1`,[id])).rows[0];
      if(!dep)return publicError(res,404,'Deployment not found');
      if(['completed','cancelled'].includes(dep.status))return publicError(res,409,`Deployment is ${dep.status}`);
      const preCounts=(await pool.query(`SELECT COUNT(*) FILTER(WHERE status='queued')::int queued,COUNT(*) FILTER(WHERE status='completed')::int success,COUNT(*) FILTER(WHERE status='failed')::int failed FROM cc_deployment_targets WHERE deployment_id=$1`,[id])).rows[0];
      if(dep.strategy==='canary' && Number(preCounts.queued)>0)return publicError(res,409,'Canary batch still has queued installations');
      const observed=Number(preCounts.success)+Number(preCounts.failed);
      const failurePct=observed>0?(Number(preCounts.failed)*100/observed):0;
      if(observed>=3 && failurePct>=Number(dep.error_threshold_pct||20)){
        await pool.query(`UPDATE cc_deployments SET status='paused',paused_at=NOW(),failed_count=$2,success_count=$3 WHERE id=$1`,[id,preCounts.failed,preCounts.success]);
        return publicError(res,409,`Deployment paused automatically: failure rate ${failurePct.toFixed(1)}%`);
      }
      await pool.query(`UPDATE cc_deployments SET status='running',started_at=COALESCE(started_at,NOW()),paused_at=NULL WHERE id=$1`,[id]);
      const batchLimit=dep.strategy==='canary'?Math.max(1,Math.ceil(Number(dep.target_count||1)*Number(dep.batch_pct||10)/100)):500;
      const targets=await pool.query(`SELECT * FROM cc_deployment_targets WHERE deployment_id=$1 AND status='pending' ORDER BY id LIMIT $2`,[id,Math.min(batchLimit,500)]);
      let queued=0,failed=0;
      for(const target of targets.rows){
        try{
          const action=dep.rollback_of?'rollback_actualizacion':(dep.release_type==='hotfix'?'aplicar_hotfix':'forzar_actualizacion');
          const cmd=await queueSignedCommand({installationUuid:target.installation_uuid,action,params:{version:dep.version,target_version:dep.version,release_id:String(dep.release_id),deployment_id:String(id),rollback_of:dep.rollback_of?String(dep.rollback_of):null},priority:'alta',title:dep.rollback_of?`Rollback a ${dep.version}`:`Desplegar ${dep.version}`,executedBy:req.user.username});
          await pool.query(`UPDATE cc_deployment_targets SET command_id=$1,status='queued',updated_at=NOW() WHERE id=$2`,[Number(cmd.id),target.id]); queued++;
        }catch(e){ await pool.query(`UPDATE cc_deployment_targets SET status='failed',last_error=$1,updated_at=NOW() WHERE id=$2`,[String(e.message).slice(0,2000),target.id]); failed++; }
      }
      const counts=(await pool.query(`SELECT COUNT(*) FILTER(WHERE status='completed')::int success,COUNT(*) FILTER(WHERE status='failed')::int failed,COUNT(*) FILTER(WHERE status IN ('pending','queued'))::int pending FROM cc_deployment_targets WHERE deployment_id=$1`,[id])).rows[0];
      const status=Number(counts.pending)===0?(Number(counts.failed)>0?'completed_with_errors':'completed'):'running';
      await pool.query(`UPDATE cc_deployments SET status=$1,success_count=$2,failed_count=$3,completed_at=CASE WHEN $1 IN ('completed','completed_with_errors') THEN NOW() ELSE completed_at END WHERE id=$4`,[status,counts.success,counts.failed,id]);
      return res.json({success:true,queued,failed,status,counts});
    }catch(error){ if(error.statusCode)return publicError(res,error.statusCode,error.message); return serverError(res,'Start deployment failed',error); }
  });

  app.post('/api/v1/deployments/:id/rollback', validateAdminAuth, requireRole('admin'), async(req,res)=>{
    const tx=await pool.connect();
    try{
      const id=intId(req.params.id); if(!id)return publicError(res,400,'Invalid deployment id');
      const original=(await tx.query(`SELECT d.*,r.version,r.rollback_version FROM cc_deployments d JOIN cc_releases r ON r.id=d.release_id WHERE d.id=$1`,[id])).rows[0];
      if(!original)return publicError(res,404,'Deployment not found');
      const targetVersion=String(req.body?.target_version||original.rollback_version||'').trim();
      if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion))return publicError(res,400,'A valid target_version or release rollback_version is required');
      const targetRelease=(await tx.query(`SELECT * FROM cc_releases WHERE version=$1 AND status='published' AND product_family IN ('ALL',$2) AND (artifact_path IS NOT NULL OR download_url ~* '^https://') AND sha256 ~ '^[a-fA-F0-9]{64}$' AND size_bytes>0 ORDER BY CASE WHEN product_family=$2 THEN 0 ELSE 1 END,id DESC LIMIT 1`,[targetVersion,original.product_family])).rows[0];
      if(!targetRelease)return publicError(res,409,'Rollback target is not a complete published release');
      const completed=(await tx.query(`SELECT installation_uuid FROM cc_deployment_targets WHERE deployment_id=$1 AND status='completed' ORDER BY id`,[id])).rows;
      if(completed.length===0)return publicError(res,409,'No successfully updated installations are available to roll back');
      await tx.query('BEGIN');
      const dep=(await tx.query(`INSERT INTO cc_deployments(release_id,name,scope_type,scope_id,product_family,strategy,status,target_count,created_by,batch_pct,error_threshold_pct,rollback_of) VALUES($1,$2,'rollback',$3,$4,'manual','draft',$5,$6,100,20,$7) RETURNING *`,[targetRelease.id,String(req.body?.name||`Rollback ${original.version} -> ${targetVersion}`).slice(0,300),String(id),original.product_family,completed.length,req.user.username,id])).rows[0];
      for(const row of completed)await tx.query(`INSERT INTO cc_deployment_targets(deployment_id,installation_uuid,status,previous_version) VALUES($1,$2,'pending',$3)`,[dep.id,row.installation_uuid,original.version]);
      await tx.query('COMMIT');
      return res.status(201).json({success:true,deployment:dep,target_version:targetVersion,eligible_targets:completed.length});
    }catch(error){await tx.query('ROLLBACK').catch(()=>{});return serverError(res,'Create rollback failed',error);}finally{tx.release();}
  });

  app.post('/api/v1/deployments/:id/pause', validateAdminAuth, requireRole('admin'), async(req,res)=>{
    try{ const id=intId(req.params.id); if(!id)return publicError(res,400,'Invalid deployment id'); const r=await pool.query(`UPDATE cc_deployments SET status='paused',paused_at=NOW() WHERE id=$1 AND status IN ('running','queued','draft') RETURNING *`,[id]); if(!r.rows[0])return publicError(res,404,'Active deployment not found'); return res.json({success:true,deployment:r.rows[0]}); }catch(error){return serverError(res,'Pause deployment failed',error);}
  });

  app.post('/api/v1/errors/report', validateClientToken, async(req,res)=>{
    const tx=await pool.connect();
    try{
      const message=String(req.body?.message||'').trim().slice(0,20000); if(!message)return publicError(res,400,'message is required');
      const moduleName=String(req.body?.module||'core').slice(0,120); const stack=String(req.body?.stack||'').slice(0,30000); const severity=String(req.body?.severity||'error').toLowerCase();
      const signature=errorSignature({module:moduleName,message,stack}); const version=String(req.body?.version||'').slice(0,80); const context=asObject(req.body?.context);
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO cc_error_groups(signature,title,module,first_seen,last_seen,occurrences,affected_installations,last_version,severity,sample_message) VALUES($1,$2,$3,NOW(),NOW(),1,1,$4,$5,$6)
        ON CONFLICT(signature) DO UPDATE SET last_seen=NOW(),occurrences=cc_error_groups.occurrences+1,last_version=EXCLUDED.last_version,severity=EXCLUDED.severity,sample_message=EXCLUDED.sample_message`,[signature,message.split('\n')[0].slice(0,300),moduleName,version,severity,message.slice(0,5000)]);
      await tx.query(`INSERT INTO cc_error_occurrences(signature,installation_uuid,client_id,version,message,context_json) VALUES($1,$2,$3,$4,$5,$6)`,[signature,req.installationUuid,req.clientId,version,message,JSON.stringify({...context,stack})]);
      const affected=(await tx.query(`SELECT COUNT(DISTINCT installation_uuid)::int count FROM cc_error_occurrences WHERE signature=$1`,[signature])).rows[0].count;
      await tx.query(`UPDATE cc_error_groups SET affected_installations=$1 WHERE signature=$2`,[affected,signature]);
      await tx.query(`UPDATE cc_installations SET last_error_signature=$1,critical_errors=critical_errors + CASE WHEN $2 IN ('critical','fatal') THEN 1 ELSE 0 END,updated_at=NOW() WHERE uuid=$3`,[signature,severity,req.installationUuid]);
      await tx.query('COMMIT'); return res.status(201).json({success:true,signature});
    }catch(error){await tx.query('ROLLBACK').catch(()=>{});return serverError(res,'Error report failed',error);}finally{tx.release();}
  });

  app.get('/api/v1/errors/groups', validateAdminAuth, requirePermission('read'), async(req,res)=>{
    try{const limit=Math.min(Math.max(Number.parseInt(String(req.query.limit||100),10)||100,1),500);const rows=await pool.query(`SELECT * FROM cc_error_groups ORDER BY last_seen DESC LIMIT $1`,[limit]);return res.json({success:true,error_groups:rows.rows});}catch(error){return serverError(res,'Error groups failed',error);}
  });

  app.get('/api/v1/agent/bootstrap', validateClientToken, async(req,res)=>{
    try{
      const inst=(await pool.query(`SELECT i.*,c.product_family,c.support_policy_json,l.status license_status_db,l.modules,l.expires_at FROM cc_installations i JOIN cc_clients c ON c.id=i.client_id LEFT JOIN cc_licenses l ON l.id=i.license_id WHERE i.uuid=$1`,[req.installationUuid])).rows[0];
      if(!inst)return publicError(res,404,'Installation not found');
      const configs=await pool.query(`SELECT config_json,version FROM cc_remote_configs WHERE active=1 AND ((scope_type='installation' AND scope_id=$1) OR (scope_type='client' AND scope_id=$2)) ORDER BY CASE WHEN scope_type='client' THEN 0 ELSE 1 END,version`,[req.installationUuid,String(req.clientId)]);
      const merged={}; let configVersion=0; for(const row of configs.rows){Object.assign(merged,asObject(row.config_json));configVersion=Math.max(configVersion,Number(row.version||0));}
      const flags=await pool.query(`SELECT f.flag_key,f.default_enabled,o_i.enabled installation_enabled,o_c.enabled client_enabled FROM cc_feature_flags f
        LEFT JOIN cc_feature_flag_overrides o_i ON o_i.flag_key=f.flag_key AND o_i.scope_type='installation' AND o_i.scope_id=$1
        LEFT JOIN cc_feature_flag_overrides o_c ON o_c.flag_key=f.flag_key AND o_c.scope_type='client' AND o_c.scope_id=$2
        WHERE f.product_family IN ('ALL',$3) ORDER BY f.flag_key`,[req.installationUuid,String(req.clientId),inst.product_family]);
      const featureFlags={}; for(const row of flags.rows){featureFlags[row.flag_key]=Number(row.installation_enabled ?? row.client_enabled ?? row.default_enabled)===1;}
      const services=await pool.query(`SELECT service_name,status,message,updated_at FROM cc_service_status ORDER BY service_name`);
      const messages=await pool.query(`SELECT id,title,body,severity,created_at,expires_at FROM cc_messages WHERE status IN ('queued','active') AND (expires_at IS NULL OR expires_at>NOW()) AND ((scope_type='installation' AND scope_id=$1) OR (scope_type='client' AND scope_id=$2)) ORDER BY created_at DESC LIMIT 20`,[req.installationUuid,String(req.clientId)]);
      return res.json({success:true,agent_contract_version:2,server_time:new Date().toISOString(),installation:{uuid:inst.uuid,maintenance_mode:Number(inst.maintenance_mode)===1,update_channel:inst.update_channel,health_score:inst.health_score},license:{status:normalizeLicenseStatus(inst.license_status_db),expires_at:inst.expires_at,modules:String(inst.modules||'').split(',').filter(Boolean),product_family:normalizeProductFamily(inst.product_family)},config:{version:configVersion,values:merged},feature_flags:featureFlags,support_policy:asObject(inst.support_policy_json),service_status:services.rows,messages:messages.rows});
    }catch(error){return serverError(res,'Agent bootstrap failed',error);}
  });

  app.post('/api/v1/agent/capabilities', validateClientToken, async(req,res)=>{
    try{
      const capabilities=Array.isArray(req.body?.capabilities)?req.body.capabilities.map(String).filter(v=>/^[a-z0-9_.:-]{2,120}$/i.test(v)).slice(0,200):[];
      const agentVersion=String(req.body?.agent_version||req.body?.agentVersion||'').slice(0,80)||null;
      const architecture=String(req.body?.architecture||'').slice(0,80)||null;
      await pool.query(`UPDATE cc_installations SET capabilities_json=$1,agent_version=COALESCE($2,agent_version),architecture=COALESCE($3,architecture),updated_at=NOW() WHERE uuid=$4`,[JSON.stringify(capabilities),agentVersion,architecture,req.installationUuid]);
      return res.json({success:true,capabilities_count:capabilities.length});
    }catch(error){return serverError(res,'Capabilities update failed',error);}
  });

  app.post('/api/v1/installations/:uuid/logs/request', validateAdminAuth, requirePermission('commands:write'), async (req, res) => {
    let requestId = null;
    try {
      const now = Date.now();
      const from = req.body?.periodo_inicio ? new Date(req.body.periodo_inicio) : new Date(now - 30 * 60 * 1000);
      const to = req.body?.periodo_fin ? new Date(req.body.periodo_fin) : new Date(now);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return publicError(res, 400, 'Invalid log period');
      if ((to.getTime() - from.getTime()) > 7 * 24 * 60 * 60 * 1000) return publicError(res, 400, 'Log request window cannot exceed 7 days');
      const request = await pool.query(
        `INSERT INTO cc_agent_artifact_requests(installation_uuid,artifact_type,status,requested_by,params_json,expires_at)
         VALUES($1,'logs','pending',$2,$3,NOW()+INTERVAL '1 hour') RETURNING id`,
        [req.params.uuid, req.user.username, JSON.stringify({ periodo_inicio: from.toISOString(), periodo_fin: to.toISOString() })],
      );
      requestId = request.rows[0].id;
      const command = await queueSignedCommand({
        installationUuid: req.params.uuid,
        action: 'enviar_log',
        params: { request_id: String(requestId), periodo_inicio: from.toISOString(), periodo_fin: to.toISOString(), max_bytes: 2 * 1024 * 1024 },
        priority: 'alta',
        title: 'Recopilar logs de soporte',
        executedBy: req.user.username,
      });
      await pool.query(`UPDATE cc_agent_artifact_requests SET command_id=$1 WHERE id=$2`, [Number(command.id), requestId]);
      return res.status(201).json({ success: true, request_id: requestId, command });
    } catch (error) {
      if (requestId) await pool.query(`UPDATE cc_agent_artifact_requests SET status='failed',completed_at=NOW() WHERE id=$1`, [requestId]).catch(() => {});
      if (error.statusCode) return publicError(res, error.statusCode, error.message);
      return serverError(res, 'Log request failed', error);
    }
  });

  app.post('/api/v1/agent/artifacts', validateClientToken, async (req, res) => {
    try {
      const artifactType = String(req.body?.artifact_type || req.body?.type || 'logs').trim().toLowerCase();
      if (!['logs', 'diagnostic', 'report', 'migration_report'].includes(artifactType)) return publicError(res, 400, 'Unsupported artifact type');
      const requestId = intId(req.body?.request_id);
      if (requestId) {
        const request = (await pool.query(`SELECT * FROM cc_agent_artifact_requests WHERE id=$1`, [requestId])).rows[0];
        if (!request || request.installation_uuid !== req.installationUuid) return publicError(res, 403, 'Artifact request does not belong to this installation');
        if (request.expires_at && new Date(request.expires_at).getTime() < Date.now()) return publicError(res, 410, 'Artifact request expired');
      }
      const content = String(req.body?.content ?? '');
      const size = Buffer.byteLength(content, 'utf8');
      if (size <= 0) return publicError(res, 400, 'Artifact content is required');
      if (size > 2 * 1024 * 1024) return publicError(res, 413, 'Text artifact exceeds 2 MiB');
      const name = String(req.body?.name || `${artifactType}-${Date.now()}.txt`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
      const mimeType = String(req.body?.mime_type || 'text/plain').slice(0, 120);
      const metadata = asObject(req.body?.metadata);
      const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const stored = await pool.query(
        `INSERT INTO cc_agent_artifacts(request_id,installation_uuid,artifact_type,name,mime_type,content_text,metadata_json,sha256,size_bytes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at`,
        [requestId || null, req.installationUuid, artifactType, name, mimeType, content, JSON.stringify(metadata), sha256, size],
      );
      if (requestId) await pool.query(`UPDATE cc_agent_artifact_requests SET status='completed',completed_at=NOW() WHERE id=$1`, [requestId]);
      return res.status(201).json({ success: true, artifact_id: stored.rows[0].id, created_at: stored.rows[0].created_at, sha256, size_bytes: size });
    } catch (error) { return serverError(res, 'Artifact upload failed', error); }
  });

  app.get('/api/v1/installations/:uuid/artifacts', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 500);
      const rows = await pool.query(
        `SELECT id,request_id,installation_uuid,artifact_type,name,mime_type,metadata_json,sha256,size_bytes,created_at
         FROM cc_agent_artifacts WHERE installation_uuid=$1 ORDER BY created_at DESC LIMIT $2`,
        [req.params.uuid, limit],
      );
      const requests = await pool.query(
        `SELECT id,artifact_type,status,command_id,requested_by,params_json,created_at,completed_at,expires_at
         FROM cc_agent_artifact_requests WHERE installation_uuid=$1 ORDER BY created_at DESC LIMIT $2`,
        [req.params.uuid, limit],
      );
      return res.json({ success: true, artifacts: rows.rows, requests: requests.rows });
    } catch (error) { return serverError(res, 'Artifact history failed', error); }
  });

  app.get('/api/v1/agent-artifacts/:id', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid artifact id');
      const artifact = (await pool.query(`SELECT * FROM cc_agent_artifacts WHERE id=$1`, [id])).rows[0];
      if (!artifact) return publicError(res, 404, 'Artifact not found');
      return res.json({ success: true, artifact });
    } catch (error) { return serverError(res, 'Artifact fetch failed', error); }
  });

  app.get('/api/v1/plans', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const rows = await pool.query(`SELECT * FROM cc_plans ORDER BY product_family,active DESC,name`);
      return res.json({ success: true, plans: rows.rows });
    } catch (error) { return serverError(res, 'Plans failed', error); }
  });

  app.put('/api/v1/plans/:key', validateAdminAuth, requireRole('admin'), async (req, res) => {
    try {
      const key = String(req.params.key).toUpperCase();
      if (!/^[A-Z0-9_-]{2,80}$/.test(key)) return publicError(res, 400, 'Invalid plan key');
      const name = String(req.body?.name || key).trim().slice(0, 160);
      const familyValue = normalizeFleetProductFamily(req.body?.product_family);
      const productFamily = familyValue === 'PUBLIC' ? 'PUBLIC' : 'COMMERCIAL';
      const billingPeriod = String(req.body?.billing_period || 'monthly').toLowerCase();
      if (!['trial', 'monthly', 'annual', 'one_time'].includes(billingPeriod)) return publicError(res, 400, 'Invalid billing_period');
      const priceMinor = Number(req.body?.price_minor ?? 0);
      if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) return publicError(res, 400, 'price_minor must be a non-negative integer');
      const limits = asObject(req.body?.limits);
      for (const field of ['users', 'devices', 'branches']) {
        if (!Number.isInteger(Number(limits[field])) || Number(limits[field]) < 1 || Number(limits[field]) > 10000) {
          return publicError(res, 400, `limits.${field} must be between 1 and 10000`);
        }
        limits[field] = Number(limits[field]);
      }
      const modules = [...new Set(asArray(req.body?.modules).map(String).map((value) => value.trim()).filter(Boolean))];
      if (modules.length === 0 || modules.length > 200) return publicError(res, 400, 'modules must contain between 1 and 200 entries');
      const active = parseBool(req.body?.active ?? true);
      if (active && billingPeriod !== 'trial' && priceMinor === 0) {
        return publicError(res, 409, 'A paid plan requires a price before it can be activated');
      }
      const currency = String(req.body?.currency || 'COP').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return publicError(res, 400, 'Invalid currency');
      const result = await pool.query(
        `INSERT INTO cc_plans
          (plan_key,name,product_family,billing_period,price_minor,limits_json,modules_json,active,currency,tax_included,description)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(plan_key) DO UPDATE SET
          name=EXCLUDED.name,product_family=EXCLUDED.product_family,billing_period=EXCLUDED.billing_period,
          price_minor=EXCLUDED.price_minor,limits_json=EXCLUDED.limits_json,modules_json=EXCLUDED.modules_json,
          active=EXCLUDED.active,currency=EXCLUDED.currency,tax_included=EXCLUDED.tax_included,
          description=EXCLUDED.description,updated_at=NOW()
         RETURNING *`,
        [key, name, productFamily, billingPeriod, priceMinor, JSON.stringify(limits), JSON.stringify(modules),
          active ? 1 : 0, currency, parseBool(req.body?.tax_included) ? 1 : 0,
          String(req.body?.description || '').trim().slice(0, 1000) || null],
      );
      return res.json({ success: true, plan: result.rows[0] });
    } catch (error) { return serverError(res, 'Plan update failed', error); }
  });

  app.get('/api/v1/clients/:id/subscription', validateAdminAuth, requirePermission('read'), async(req,res)=>{try{const id=intId(req.params.id);if(!id)return publicError(res,400,'Invalid client id');const r=await pool.query(`SELECT s.*,p.name plan_name,p.limits_json,p.modules_json FROM cc_client_subscriptions s LEFT JOIN cc_plans p ON p.plan_key=s.plan_key WHERE s.client_id=$1`,[id]);return res.json({success:true,subscription:r.rows[0]||null});}catch(error){return serverError(res,'Subscription failed',error);}});
  app.put('/api/v1/clients/:id/subscription', validateAdminAuth, requirePermission('billing:write'), async(req,res)=>{try{const id=intId(req.params.id);if(!id)return publicError(res,400,'Invalid client id');const planKey=String(req.body?.plan_key||'').toUpperCase();if(!(await pool.query(`SELECT 1 FROM cc_plans WHERE plan_key=$1 AND active=1`,[planKey])).rows[0])return publicError(res,404,'Plan not found');const r=await pool.query(`INSERT INTO cc_client_subscriptions(client_id,plan_key,status,started_at,current_period_end,cancel_at_period_end,metadata_json) VALUES($1,$2,$3,NOW(),$4,$5,$6) ON CONFLICT(client_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,cancel_at_period_end=EXCLUDED.cancel_at_period_end,metadata_json=EXCLUDED.metadata_json RETURNING *`,[id,planKey,String(req.body?.status||'active'),req.body?.current_period_end||null,parseBool(req.body?.cancel_at_period_end)?1:0,JSON.stringify(asObject(req.body?.metadata))]);return res.json({success:true,subscription:r.rows[0]});}catch(error){return serverError(res,'Subscription update failed',error);}});

  app.get('/api/v1/clients/:id/organizations', validateAdminAuth, requirePermission('read'), async(req,res)=>{try{const id=intId(req.params.id);if(!id)return publicError(res,400,'Invalid client id');const orgs=await pool.query(`SELECT o.*,COALESCE(json_agg(b ORDER BY b.id) FILTER(WHERE b.id IS NOT NULL),'[]') branches FROM cc_organizations o LEFT JOIN cc_branches b ON b.organization_id=o.id WHERE o.client_id=$1 GROUP BY o.id ORDER BY o.id`,[id]);return res.json({success:true,organizations:orgs.rows});}catch(error){return serverError(res,'Organizations failed',error);}});
  app.post('/api/v1/clients/:id/organizations', validateAdminAuth, requirePermission('crm:write'), async(req,res)=>{try{const id=intId(req.params.id);if(!id)return publicError(res,400,'Invalid client id');const name=String(req.body?.name||'').trim();if(!name)return publicError(res,400,'name is required');const r=await pool.query(`INSERT INTO cc_organizations(client_id,name,code,status) VALUES($1,$2,$3,$4) RETURNING *`,[id,name,String(req.body?.code||'').trim()||null,String(req.body?.status||'active')]);return res.status(201).json({success:true,organization:r.rows[0]});}catch(error){return serverError(res,'Organization create failed',error);}});
  app.post('/api/v1/organizations/:id/branches', validateAdminAuth, requirePermission('crm:write'), async(req,res)=>{try{const id=intId(req.params.id);if(!id)return publicError(res,400,'Invalid organization id');const name=String(req.body?.name||'').trim();if(!name)return publicError(res,400,'name is required');const r=await pool.query(`INSERT INTO cc_branches(organization_id,name,code,city,status) VALUES($1,$2,$3,$4,$5) RETURNING *`,[id,name,String(req.body?.code||'').trim()||null,String(req.body?.city||'').trim()||null,String(req.body?.status||'active')]);return res.status(201).json({success:true,branch:r.rows[0]});}catch(error){return serverError(res,'Branch create failed',error);}});

  app.get('/api/v1/clients/:id/activity', validateAdminAuth, requirePermission('read'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid client id');
      const requestedLimit = Number.parseInt(String(req.query.limit || '200'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 200, 1), 500);
      const type = String(req.query.type || '').trim().toLowerCase();
      const params = [id];
      let typeWhere = '';
      if (type) { params.push(type); typeWhere = ` AND activity_type=$${params.length}`; }
      params.push(limit);
      const rows = await pool.query(
        `SELECT id,client_id,activity_type,title,content,direction,channel,metadata_json,created_by,created_at
         FROM cc_client_activity WHERE client_id=$1${typeWhere} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return res.json({ success: true, activity: rows.rows });
    } catch (error) { return serverError(res, 'Client activity failed', error); }
  });

  app.post('/api/v1/clients/:id/activity', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid client id');
      if (!(await pool.query('SELECT 1 FROM cc_clients WHERE id=$1', [id])).rows[0]) return publicError(res, 404, 'Client not found');
      const activityType = String(req.body?.activity_type || 'note').trim().toLowerCase();
      if (!['note','email','call','meeting','system','support'].includes(activityType)) return publicError(res, 400, 'Invalid activity type');
      const content = String(req.body?.content || '').trim().slice(0, 20000);
      if (!content) return publicError(res, 400, 'content is required');
      const title = String(req.body?.title || '').trim().slice(0, 300) || null;
      const direction = String(req.body?.direction || '').trim().toLowerCase();
      if (direction && !['inbound','outbound','internal'].includes(direction)) return publicError(res, 400, 'Invalid direction');
      const channel = String(req.body?.channel || '').trim().toLowerCase().slice(0, 80) || null;
      const row = await pool.query(
        `INSERT INTO cc_client_activity(client_id,activity_type,title,content,direction,channel,metadata_json,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, activityType, title, content, direction || null, channel, JSON.stringify(asObject(req.body?.metadata)), req.user.username],
      );
      return res.status(201).json({ success: true, activity: row.rows[0] });
    } catch (error) { return serverError(res, 'Client activity create failed', error); }
  });

  app.post('/api/v1/licenses/:id/lifecycle', validateAdminAuth, requirePermission('licenses:write'), async (req, res) => {
    const tx = await pool.connect();
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid license id');
      const action = String(req.body?.action || '').toLowerCase();
      if (!['suspend', 'reactivate', 'revoke'].includes(action)) return publicError(res, 400, 'action must be suspend, reactivate or revoke');
      const reason = String(req.body?.reason || '').trim().slice(0, 1000);
      await tx.query('BEGIN');
      const current = (await tx.query(`SELECT * FROM cc_licenses WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) {
        await tx.query('ROLLBACK');
        return publicError(res, 404, 'License not found');
      }
      const currentStatus = normalizeLicenseStatus(current.status);
      const newStatus = action === 'reactivate' ? 'active' : action === 'suspend' ? 'suspended' : 'revoked';
      if (currentStatus === newStatus) {
        await tx.query('ROLLBACK');
        return res.json({ success: true, id, status: currentStatus, unchanged: true });
      }
      if (currentStatus === 'revoked') {
        await tx.query('ROLLBACK');
        return publicError(res, 409, 'A revoked license is immutable; issue a new license instead');
      }
      if (action === 'suspend' && !['active', 'trial'].includes(currentStatus)) {
        await tx.query('ROLLBACK');
        return publicError(res, 409, `Cannot suspend a ${currentStatus} license`);
      }
      // A trial becomes active when it is renewed into a paid plan. Keeping
      // that transition here prevents callers from bypassing the lifecycle
      // audit by writing status directly through PUT /licenses/:id.
      if (action === 'reactivate' && !['trial', 'suspended', 'expired'].includes(currentStatus)) {
        await tx.query('ROLLBACK');
        return publicError(res, 409, `Cannot reactivate a ${currentStatus} license`);
      }
      if (action === 'reactivate' && (Number.isNaN(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now())) {
        await tx.query('ROLLBACK');
        return publicError(res, 409, 'Renew the license expiry date before reactivating it');
      }
      const lifecycleReason = reason || `Licencia ${newStatus}`;
      await tx.query(
        `UPDATE cc_licenses SET status=$1,status_reason=$2,
         suspended_at=CASE WHEN $1='suspended' THEN NOW() ELSE suspended_at END,
         revoked_at=CASE WHEN $1='revoked' THEN NOW() ELSE revoked_at END,
         reactivated_at=CASE WHEN $1='active' THEN NOW() ELSE reactivated_at END,
         suspension_source=CASE WHEN $1='suspended' THEN 'license' WHEN $1='active' THEN NULL ELSE suspension_source END,
         offline_token=NULL,updated_at=NOW() WHERE id=$3`,
        [newStatus, lifecycleReason, id],
      );
      if (newStatus === 'active') {
        await tx.query(
          `UPDATE cc_installations SET blocked=0,block_reason=NULL,license_status='active',status='active',updated_at=NOW()
           WHERE license_id=$1 AND status<>'disabled' AND (block_reason IS NULL OR block_reason LIKE 'Licencia:%')`,
          [id],
        );
      } else {
        await tx.query(
          `UPDATE cc_installations SET blocked=1,block_reason=$1,license_status=$2,status='blocked',connected=0,updated_at=NOW()
           WHERE license_id=$3 AND status<>'disabled'`,
          [`Licencia: ${lifecycleReason}`, newStatus, id],
        );
        await tx.query(
          `UPDATE cc_offline_activations SET revoked_at=COALESCE(revoked_at,NOW()),revoked_reason=COALESCE(revoked_reason,$1) WHERE license_id=$2`,
          [lifecycleReason, id],
        );
      }
      await tx.query('COMMIT');
      return res.json({ success: true, id, status: newStatus });
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      return serverError(res, 'License lifecycle failed', error);
    } finally { tx.release(); }
  });

  app.post('/api/v1/clients/:id/lifecycle', validateAdminAuth, requirePermission('crm:write'), async (req, res) => {
    const tx = await pool.connect();
    try {
      const id = intId(req.params.id);
      if (!id) return publicError(res, 400, 'Invalid client id');
      const action = String(req.body?.action || '').toLowerCase();
      if (!['suspend', 'reactivate', 'archive'].includes(action)) return publicError(res, 400, 'action must be suspend, reactivate or archive');
      const reason = String(req.body?.reason || '').trim().slice(0, 1000);
      await tx.query('BEGIN');
      const current = (await tx.query(`SELECT id,status FROM cc_clients WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) {
        await tx.query('ROLLBACK');
        return publicError(res, 404, 'Client not found');
      }
      const currentStatus = normalizeLicenseStatus(current.status);
      const status = action === 'reactivate' ? 'active' : action === 'suspend' ? 'suspended' : 'cancelled';
      if (currentStatus === status) {
        await tx.query('ROLLBACK');
        return res.json({ success: true, id, status, previous_status: current.status, unchanged: true });
      }
      if (currentStatus === 'cancelled') {
        await tx.query('ROLLBACK');
        return publicError(res, 409, 'An archived client is immutable; create a new commercial relationship instead');
      }
      if (action === 'suspend' && !['active', 'trial'].includes(currentStatus)) {
        await tx.query('ROLLBACK');
        return publicError(res, 409, `Cannot suspend a ${currentStatus} client`);
      }
      if (action === 'reactivate' && currentStatus !== 'suspended') {
        await tx.query('ROLLBACK');
        return publicError(res, 409, `Cannot reactivate a ${currentStatus} client`);
      }
      await tx.query(
        `UPDATE cc_clients SET status=$1,lifecycle_reason=$2,
         archived_at=CASE WHEN $1='cancelled' THEN NOW() WHEN $1='active' THEN NULL ELSE archived_at END,
         updated_at=NOW() WHERE id=$3`,
        [status, reason || null, id],
      );
      if (status === 'active') {
        // Reactivation restores only licenses suspended with the client. Revoked
        // licenses remain immutable and require a new issuance.
        await tx.query(
          `UPDATE cc_licenses SET status='active',status_reason=NULL,reactivated_at=NOW(),suspension_source=NULL,updated_at=NOW()
           WHERE client_id=$1 AND status='suspended' AND suspension_source='client'
             AND expires_at::timestamptz > NOW()`,
          [id],
        );
        await tx.query(
          `UPDATE cc_installations i SET blocked=0,block_reason=NULL,status='active',license_status=l.status,updated_at=NOW()
           FROM cc_licenses l
           WHERE i.client_id=$1 AND i.license_id=l.id AND l.status IN ('active','trial')
             AND i.status<>'disabled' AND (i.block_reason IS NULL OR i.block_reason LIKE 'Cliente:%' OR i.block_reason LIKE 'Licencia:%')`,
          [id],
        );
      } else if (status === 'suspended') {
        await tx.query(
          `UPDATE cc_licenses SET status='suspended',status_reason=$2,suspended_at=NOW(),suspension_source='client',updated_at=NOW()
           WHERE client_id=$1 AND status IN ('active','trial')`,
          [id, reason || 'Cliente suspendido'],
        );
        await tx.query(
          `UPDATE cc_installations SET blocked=1,connected=0,status='blocked',license_status='suspended',block_reason=$2,updated_at=NOW()
           WHERE client_id=$1 AND status<>'disabled'`,
          [id, `Cliente: ${reason || 'suspendido'}`],
        );
      } else {
        await tx.query(
          `UPDATE cc_licenses SET status='revoked',status_reason=$2,updated_at=NOW(),revoked_at=NOW(),offline_token=NULL
           WHERE client_id=$1 AND status<>'revoked'`,
          [id, reason || 'Cliente archivado/cancelado'],
        );
        await tx.query(
          `UPDATE cc_offline_activations oa SET revoked_at=COALESCE(oa.revoked_at,NOW()),revoked_reason=COALESCE(oa.revoked_reason,$2)
           WHERE oa.license_id IN (SELECT l.id FROM cc_licenses l WHERE l.client_id=$1)`,
          [id, reason || 'Cliente archivado/cancelado'],
        );
        await tx.query(
          `UPDATE cc_installations SET blocked=1,connected=0,status='blocked',license_status='revoked',block_reason=$2,updated_at=NOW()
           WHERE client_id=$1 AND status<>'disabled'`,
          [id, `Cliente: ${reason || 'archivado/cancelado'}`],
        );
      }
      await tx.query('COMMIT');
      return res.json({ success: true, id, status, previous_status: current.status });
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      return serverError(res, 'Client lifecycle failed', error);
    } finally { tx.release(); }
  });

}

module.exports = { registerFleetRoutes };
