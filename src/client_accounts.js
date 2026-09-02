// Client identity is independent of purchases: one account can own many licenses.
async function findClientConflict(db, { nit, email, id = null }) {
  for (const [field, column, value] of [
    ['nit', 'nit', nit],
    ['email', 'contact_email', email],
  ]) {
    if (!String(value || '').trim()) continue;
    const result = await db.query(
      `SELECT id,name,nit,status FROM cc_clients
       WHERE LOWER(TRIM(${column}))=LOWER(TRIM($1))
         AND ($2::int IS NULL OR id<>$2::int) ORDER BY id LIMIT 1`,
      [String(value).trim(), id],
    );
    if (result.rows[0]) return { field, client: result.rows[0] };
  }
  return null;
}

function clientConflictResponse(conflict, normalizeStatus) {
  const client = { ...conflict.client, status: normalizeStatus(conflict.client.status) };
  const archived = client.status === 'cancelled';
  return {
    success: false,
    code: archived ? 'CLIENT_ARCHIVED' : 'CLIENT_EXISTS',
    field: conflict.field,
    client,
    error: archived
      ? 'Este cliente está archivado. Puede recuperarlo sin reactivar sus licencias anteriores.'
      : 'Este cliente ya existe. Añada una nueva licencia a su ficha para registrar otra compra.',
  };
}

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

// Include legacy relations without an FK, as well as declared foreign keys.
// The catalog, never request data, supplies SQL identifiers.
async function clientRelations(tx) {
  const result = await tx.query(`
    SELECT table_schema AS schema_name, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND column_name='client_id'
    UNION
    SELECT ns.nspname, rel.relname, attr.attname
    FROM pg_constraint fk
    JOIN pg_class rel ON rel.oid=fk.conrelid
    JOIN pg_namespace ns ON ns.oid=rel.relnamespace
    JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS src(attnum, ord) ON true
    JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY AS dst(attnum, ord) ON src.ord=dst.ord
    JOIN pg_attribute attr ON attr.attrelid=rel.oid AND attr.attnum=src.attnum
    JOIN pg_attribute target ON target.attrelid=fk.confrelid AND target.attnum=dst.attnum
    WHERE fk.contype='f' AND fk.confrelid='cc_clients'::regclass AND target.attname='id'
    ORDER BY 1,2,3
  `);
  return result.rows;
}

function registerClientAccountRoutes({ app, pool, validateAdminAuth, requireRole, publicError, serverError, normalizeLicenseStatus }) {
  app.post('/api/v1/clients/:id/permanent-delete', validateAdminAuth, requireRole('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return publicError(res, 400, 'ID de cliente no válido.');
    if (req.body?.confirmation !== `ELIMINAR ${id}`) {
      return publicError(res, 400, `Confirme la eliminación escribiendo ELIMINAR ${id}.`);
    }
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const current = (await tx.query('SELECT id,status FROM cc_clients WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) {
        await tx.query('ROLLBACK');
        return publicError(res, 404, 'Cliente no encontrado.');
      }
      if (normalizeLicenseStatus(current.status) !== 'cancelled') {
        await tx.query('ROLLBACK');
        return publicError(res, 409, 'Primero debe archivar al cliente.');
      }
      const relations = await clientRelations(tx);
      // No cascading deletion: briefly block writes while checking, including
      // tables without foreign keys. NOWAIT fails closed if another writer is busy.
      const tables = [...new Set(relations.map((r) => `${quoteIdentifier(r.schema_name)}.${quoteIdentifier(r.table_name)}`))];
      if (tables.length) await tx.query(`LOCK TABLE ${tables.join(',')} IN SHARE MODE NOWAIT`);
      const dependencies = [];
      for (const relation of relations) {
        const table = `${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(relation.table_name)}`;
        const found = await tx.query(`SELECT 1 FROM ${table} WHERE ${quoteIdentifier(relation.column_name)}=$1 LIMIT 1`, [id]);
        if (found.rows.length) dependencies.push(relation.table_name);
      }
      const tenantSchema = await tx.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [`client_${id}`]);
      if (tenantSchema.rows.length) dependencies.push('base_de_datos_del_cliente');
      if (dependencies.length) {
        await tx.query('ROLLBACK');
        return res.status(409).json({
          success: false, code: 'CLIENT_HAS_HISTORY', dependencies: [...new Set(dependencies)],
          error: 'No se puede eliminar definitivamente: el cliente tiene historial o registros asociados. Puede conservarlo archivado o recuperarlo.',
        });
      }
      await tx.query('DELETE FROM cc_clients WHERE id=$1', [id]);
      // Keep a minimal deletion audit, without retaining the erased profile.
      await tx.query(`INSERT INTO cc_audit(actor,action,entity,detail,created_at)
        VALUES ($1,'ELIMINAR_CLIENTE_DEFINITIVO','client',$2,$3)`,
      [req.user.username, `client_id=${id}; sin registros asociados`, new Date().toISOString()]);
      await tx.query('COMMIT');
      return res.json({ success: true, id, deleted: true });
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      if (['55P03', '40P01', '23503'].includes(error.code)) {
        return publicError(res, 409, 'El cliente tiene registros relacionados o hay operaciones en curso. No se ha eliminado.');
      }
      return serverError(res, 'No fue posible eliminar definitivamente al cliente', error);
    } finally { tx.release(); }
  });
}

module.exports = { findClientConflict, clientConflictResponse, registerClientAccountRoutes };
