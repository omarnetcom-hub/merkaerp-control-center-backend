# Sync Worker

Responsabilidades:

1. Leer eventos de `/api/v1/sync/push`.
2. Validar licencia, tenant, empresa, sucursal y permisos.
3. Aplicar idempotencia por `idempotency_key`.
4. Persistir en PostgreSQL.
5. Detectar conflictos por `aggregate_type`, `aggregate_id` y vector clock.
6. Publicar eventos para pull incremental.
7. Registrar metricas y trazas por `correlation_id`.
