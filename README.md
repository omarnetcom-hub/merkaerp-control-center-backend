# MerkaERP Control Center Backend

Backend del Centro de Control para MerkaERP - Sistema de administración remota, licencias, actualizaciones y telemetría.

## Stack Tecnológico

- **Node.js** + **Express** - Servidor API REST
- **SQLite** - Base de datos local para el Centro de Control
- **CORS** - Habilitado para comunicación con clientes Flutter
- **Helmet** - Seguridad HTTP headers
- **Morgan** - Logging de requests
- **express-rate-limit** - Limitación de requests

## Instalación

### Requisitos previos
- Node.js (v14 o superior)
- npm o yarn

### Pasos de instalación

1. Navegar al directorio del backend:
```bash
cd backend
```

2. Instalar dependencias:
```bash
npm install
```

3. Configurar variables de entorno (opcional, ya hay valores por defecto en `.env`):
```bash
# Editar .env si es necesario
PORT=8787
NODE_ENV=development
DB_PATH=./data/control_center.db
JWT_SECRET=tu_secreto_jwt_aqui_cambiar_en_produccion
CORS_ORIGIN=*
```

4. Iniciar el servidor:
```bash
# Modo desarrollo (con auto-reload)
npm run dev

# Modo producción
npm start
```

El servidor iniciará en `http://localhost:8787`

## Endpoints API

### Instalaciones y Heartbeats

- `POST /api/v1/installations/heartbeat` - Recibe heartbeat del cliente
- `GET /api/v1/installations` - Lista todas las instalaciones
- `GET /api/v1/installations/:id` - Obtiene detalles de una instalación
- `POST /api/v1/installations/:id/block` - Bloquea una instalación
- `POST /api/v1/installations/:id/unblock` - Desbloquea una instalación
- `GET /api/v1/installations/:id/commands` - Obtiene comandos pendientes
- `POST /api/v1/installations/:id/rollback` - Solicita rollback de actualización
- `POST /api/v1/installations/:id/license` - Actualiza licencia
- `GET /api/v1/installations/:id/license` - Obtiene licencia

### Telemetría

- `POST /api/v1/telemetry/events` - Recibe eventos de telemetría
- `GET /api/v1/telemetry/events` - Lista eventos de telemetría
- `GET /api/v1/telemetry/stats` - Estadísticas de telemetría

### Comandos Remotos

- `POST /api/v1/commands` - Crea nuevo comando remoto
- `GET /api/v1/commands` - Lista comandos
- `POST /api/v1/commands/:id/ack` - Acknowledge comando
- `DELETE /api/v1/commands/:id` - Elimina comando

### Actualizaciones

- `GET /api/v1/updates/check` - Verifica actualizaciones disponibles
- `POST /api/v1/updates` - Crea nueva actualización (admin)
- `GET /api/v1/updates` - Lista actualizaciones
- `DELETE /api/v1/updates/:id` - Elimina actualización

### Health Check

- `GET /health` - Estado del servidor
- `GET /` - Información del servidor

## Configuración del Cliente Flutter

En la aplicación Flutter, el endpoint del Centro de Control se configura en la base de datos:

```sql
INSERT OR REPLACE INTO app_config (clave, valor) 
VALUES ('control_center_endpoint', 'http://localhost:8787');
```

O cambiarlo por la URL del servidor en producción.

## Base de Datos

El servidor crea automáticamente las siguientes tablas:

- `installations` - Información de instalaciones clientes
- `heartbeats` - Historial de heartbeats
- `telemetry_events` - Eventos de telemetría
- `remote_commands` - Comandos remotos pendientes
- `updates` - Actualizaciones disponibles
- `licenses` - Licencias de instalaciones

## Ejemplos de Uso

### Enviar heartbeat (desde cliente Flutter)
```bash
curl -X POST http://localhost:8787/api/v1/installations/heartbeat \
  -H "Content-Type: application/json" \
  -d '{
    "installationId": "MERKA-12345",
    "companyName": "Mi Empresa",
    "taxId": "900123456",
    "version": "1.0.0",
    "os": "windows",
    "licenseStatus": "active",
    "licensePlan": "profesional",
    "licenseExpiry": "2024-12-31T23:59:59Z",
    "syncStatus": "ok",
    "databaseStatus": "ok",
    "criticalErrors": 0,
    "updateAvailable": false,
    "metrics": {
      "dbResponseMs": 50,
      "memoryRssMb": 256,
      "dbSizeMb": 10
    }
  }'
```

### Listar instalaciones
```bash
curl http://localhost:8787/api/v1/installations
```

### Bloquear instalación
```bash
curl -X POST http://localhost:8787/api/v1/installations/MERKA-12345/block \
  -H "Content-Type: application/json" \
  -d '{"reason": "Pago pendiente"}'
```

### Crear comando remoto
```bash
curl -X POST http://localhost:8787/api/v1/commands \
  -H "Content-Type: application/json" \
  -d '{
    "installationId": "MERKA-12345",
    "action": "enviar_notificacion",
    "params": {
      "title": "Mensaje del administrador",
      "detail": "Actualización disponible",
      "priority": "info"
    }
  }'
```

### Crear actualización
```bash
curl -X POST http://localhost:8787/api/v1/updates \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.1.0",
    "canal": "stable",
    "url_descarga": "https://example.com/merkaerp-1.1.0.exe",
    "tamano_bytes": 50000000,
    "sha256": "abc123...",
    "notas": "Corrección de errores y mejoras",
    "obligatoria": false
  }'
```

## Desarrollo

Para desarrollo con auto-reload:
```bash
npm run dev
```

## Producción

Para producción:
1. Cambiar `NODE_ENV=production` en `.env`
2. Cambiar `JWT_SECRET` a un valor seguro
3. Configurar `CORS_ORIGIN` con el dominio permitido
4. Usar un servidor de producción (PM2, Docker, etc.)

## Seguridad

- Rate limiting: 100 requests por 15 minutos por IP
- Helmet: Headers de seguridad HTTP
- CORS: Configurable por origen
- Validación de datos en todos los endpoints

## Troubleshooting

### Error: EADDRINUSE
El puerto 8787 ya está en uso. Cambiar `PORT` en `.env` o matar el proceso que usa el puerto.

### Error: Cannot find module
Ejecutar `npm install` para instalar dependencias.

### Base de datos corrupta
Eliminar el archivo `data/control_center.db` y reiniciar el servidor para recrear las tablas.
