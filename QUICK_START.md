# 🚀 GUÍA DE INICIO RÁPIDO - Odoo 19.0 en Caja Simple

## Lo que Acabamos de Implementar

✅ **Sistema ERP completamente autónomo** (sin conectarse a Odoo)
✅ **Módulos funcionales**: Base, Contactos, Productos, Stock, Ventas, Compras, Contabilidad
✅ **API REST completa** con 49+ endpoints
✅ **Autenticación JWT** 
✅ **Soporte PostgreSQL y SQLite**
✅ **Migraciones automáticas**

---

## Instalación Rápida (5 minutos)

### 1️⃣ Preparar Variables de Entorno

```bash
cd backend

# Copiar template
cp .env.example .env

# Editar .env con tus credenciales
nano .env
```

**Para PostgreSQL (Render):**
```env
DATABASE_URL=postgresql://user:password@host:port/database
NODE_ENV=production
```

**Para SQLite (desarrollo local):**
```env
DB_PATH=./data/cajasimple.db
NODE_ENV=development
```

### 2️⃣ Ejecutar Setup Automático

```bash
# Instala dependencias y crea migraciones automáticamente
node setup-odoo.js
```

**Esto hace:**
- ✓ Instala npm dependencies
- ✓ Crea archivo .env
- ✓ Ejecuta migraciones SQL
- ✓ Valida conexión a BD

### 3️⃣ Iniciar el Servidor

```bash
npm start
```

**Output esperado:**
```
✓ Base de datos inicializada correctamente
🚀 Inicializando módulos Odoo 19.0...
✓ Módulos Odoo inicializados

✓ Servidor del Centro de Control corriendo en puerto 8787
✓ Environment: development
✓ API Odoo disponible en: http://localhost:8787/api/odoo
✓ Documentación en: http://localhost:8787/api/odoo/docs
```

### 4️⃣ Verificar que Funciona

```bash
# En otra terminal

# Health check
curl http://localhost:8787/api/odoo/health

# API documentation
curl http://localhost:8787/api/odoo/docs

# Debería responder con JSON
```

---

## Usando el Sistema

### Crear una Empresa

```bash
curl -X POST http://localhost:8787/api/odoo/companies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mi Empresa",
    "email": "info@miempresa.com",
    "phone": "+34666000000",
    "city": "Madrid",
    "country_id": 1,
    "currency_id": 1
  }'
```

### Crear un Usuario

```bash
curl -X POST http://localhost:8787/api/odoo/users \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Juan Pérez",
    "email": "juan@miempresa.com",
    "login": "juan",
    "password": "MiPassword123!",
    "company_id": 1
  }'
```

### Crear un Producto

```bash
curl -X POST http://localhost:8787/api/odoo/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Laptop Dell",
    "code": "DELL-XPS-13",
    "type": "product",
    "price": 1299.99,
    "cost": 800.00,
    "description": "Laptop de alta gama"
  }'
```

### Crear una Orden de Venta

```bash
curl -X POST http://localhost:8787/api/odoo/sale-orders \
  -H "Content-Type: application/json" \
  -d '{
    "partner_id": 1,
    "company_id": 1,
    "order_date": "2024-01-15",
    "currency_id": 1,
    "user_id": 1
  }'
```

### Agregar Línea a la Orden

```bash
curl -X POST http://localhost:8787/api/odoo/sale-orders/1/lines \
  -H "Content-Type: application/json" \
  -d '{
    "product_id": 1,
    "quantity": 2,
    "price_unit": 1299.99
  }'
```

---

## Scripts Disponibles

```bash
# Instalar y configurar todo
npm run setup-odoo

# Aplicar migraciones
npm run migrate-odoo

# Iniciar servidor en desarrollo
npm run dev

# Iniciar servidor
npm start

# Pruebas API (Linux/Mac)
npm run test-api
```

---

## Estructura de Carpetas

```
backend/
├── src/
│   ├── modules/              # Módulos Odoo
│   │   ├── base/            # Usuarios, Empresas
│   │   ├── contacts/        # Clientes, Proveedores
│   │   ├── product/         # Productos
│   │   ├── sale/            # Órdenes de Venta
│   │   ├── purchase/        # Órdenes de Compra
│   │   ├── stock/           # Inventario
│   │   ├── account/         # Facturación
│   │   └── ...
│   ├── database/            # Base de datos
│   │   └── migrations/      # Migraciones SQL
│   ├── middleware/          # Middleware (auth, etc)
│   ├── routes/              # Rutas API
│   └── server.js            # Servidor principal
│
├── setup-odoo.js            # Setup automático
├── migrate-odoo.js          # Migraciones
├── test_api.sh              # Tests
├── ODOO_IMPLEMENTATION.md   # Documentación
└── package.json
```

---

## Endpoints Disponibles

### Base Module
```
POST   /api/odoo/companies      - Crear empresa
GET    /api/odoo/companies      - Listar empresas
POST   /api/odoo/users          - Crear usuario
GET    /api/odoo/users          - Listar usuarios
```

### Contacts Module
```
POST   /api/odoo/partners           - Crear contacto
GET    /api/odoo/partners           - Listar contactos
GET    /api/odoo/partners/type/customers  - Clientes
GET    /api/odoo/partners/type/suppliers  - Proveedores
```

### Product Module
```
POST   /api/odoo/products           - Crear producto
GET    /api/odoo/products           - Listar productos
GET    /api/odoo/products/search/:term  - Buscar
```

### Sale Module
```
POST   /api/odoo/sale-orders           - Crear orden
GET    /api/odoo/sale-orders           - Listar órdenes
POST   /api/odoo/sale-orders/:id/confirm  - Confirmar
POST   /api/odoo/sale-orders/:id/lines    - Agregar línea
```

### Purchase Module
```
POST   /api/odoo/purchase-orders       - Crear orden
GET    /api/odoo/purchase-orders       - Listar órdenes
POST   /api/odoo/purchase-orders/:id/confirm - Confirmar
```

### Account Module (Invoices)
```
POST   /api/odoo/invoices          - Crear factura
GET    /api/odoo/invoices          - Listar facturas
POST   /api/odoo/invoices/:id/post - Publicar factura
```

---

## Solución de Problemas

### Error: "Base de datos no encontrada"
```bash
# Asegúrate que DATABASE_URL o DB_PATH están en .env
cat .env | grep -i database

# Si usas PostgreSQL, verifica conexión
psql -U user -h host -d database -c "SELECT 1"
```

### Error: "Puerto 8787 en uso"
```bash
# Cambiar puerto en .env
PORT=3000

# O matar proceso existente
lsof -i :8787
kill -9 <PID>
```

### Error: "Módulos no encontrados"
```bash
# Reinstalar dependencias
rm -rf node_modules package-lock.json
npm install
```

---

## Documentación Completa

- **ODOO_IMPLEMENTATION.md** - Guía técnica completa
- **DEVELOPER_REFERENCE.md** - Referencia para desarrolladores
- **INTEGRATION_GUIDE.js** - Pasos de integración detallados

---

## ¿Qué Implementamos?

### FASE 1 (Completada ✅)

**7 Módulos Principales:**

1. **Base Module**
   - Gestión de usuarios
   - Gestión de empresas
   - Control de acceso por roles

2. **Contacts Module**
   - Registro de clientes
   - Registro de proveedores
   - Gestión de contactos

3. **Product Module**
   - Catálogo de productos
   - Categorías
   - Variantes de productos
   - Precios y costos

4. **Stock Module**
   - Gestión de inventario
   - Movimientos de stock
   - Ubicaciones de almacén

5. **Sale Module**
   - Órdenes de venta
   - Gestión de líneas
   - Estados de orden
   - Confirmación y seguimiento

6. **Purchase Module**
   - Órdenes de compra
   - Gestión de proveedores
   - Confirmación de órdenes

7. **Account Module**
   - Facturación
   - Libro mayor
   - Diarios contables
   - Estados de factura

### FASE 2-4 (Próximas)
- POS (Point of Sale)
- HR (Recursos Humanos)
- CRM (Gestión de Relaciones)
- Manufacturing (Fabricación)
- Projects (Proyectos)
- Y más...

---

## Características Principales

✅ **22 tablas de base de datos**
✅ **49+ API endpoints REST**
✅ **Autenticación JWT**
✅ **Múltiples empresas soportadas**
✅ **Control de roles y permisos**
✅ **Búsqueda y filtrado avanzado**
✅ **Gestión de estados de órdenes**
✅ **Workflow de facturas**
✅ **Seguimiento de inventario**
✅ **Precios y costos**

---

## Soporte Técnico

Si tienes problemas:

1. Revisa los logs del servidor
2. Consulta la documentación en `/backend/DEVELOPER_REFERENCE.md`
3. Verifica tu conexión a BD
4. Asegúrate que .env tiene valores correctos

---

## 🎉 ¡Listo!

Tu ERP Odoo 19.0 completamente autónomo está operativo en tu servidor.

```
✓ Módulos: 7 (activos)
✓ Endpoints: 49+
✓ Tablas: 22
✓ Estado: Funcionando
✓ Independencia: 100% (sin Odoo externo)
```

**Inicia con:**
```bash
npm start
```

**Accede a:**
- API: http://localhost:8787/api/odoo
- Docs: http://localhost:8787/api/odoo/docs
- Health: http://localhost:8787/api/odoo/health
