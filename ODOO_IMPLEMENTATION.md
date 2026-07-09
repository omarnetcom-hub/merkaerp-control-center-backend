# Odoo 19.0 Implementation for Caja Simple (MerkaERP)

## Overview
Este proyecto implementa la funcionalidad principal de **Odoo 19.0** en el backend de **Caja Simple (MerkaERP)**, un sistema ERP completo basado en Node.js + Express + PostgreSQL.

## Architecture

### Estructura de Módulos
```
backend/src/modules/
├── base/              # Users, Companies, Access Control
├── contacts/          # Partners (Customers, Suppliers, Contacts)
├── product/           # Products, Categories, UOM
├── stock/             # Inventory, Stock Moves, Locations
├── account/           # Invoices, Chart of Accounts, Journals
├── purchase/          # Purchase Orders
├── sale/              # Sale Orders
├── point_of_sale/     # POS System
├── hr/                # Human Resources
├── crm/               # Customer Relationship Management
├── project/           # Project Management
├── manufacturing/     # Manufacturing (MRP)
└── timesheet/         # Timesheets & HR Tracking
```

## PHASE 1: Core Implementation (✓ Completed)

### Implemented Modules:
1. **Base Module** - Users, Companies, Roles
   - User management with role-based access
   - Multi-company support
   - User authentication

2. **Contacts Module** - Partners
   - Customers, Suppliers, Contacts
   - Address management
   - Partner search and filtering

3. **Product Module** - Products
   - Product catalog with categories
   - SKU/Code management
   - Product variants
   - Pricing and cost tracking

4. **Stock Module** - Inventory
   - Stock locations
   - Stock moves (incoming, outgoing, internal)
   - Product quantity tracking

5. **Account Module** - Invoicing
   - Invoice creation and management
   - Invoice lines with line items
   - Invoice states (draft, posted, paid)
   - Chart of Accounts
   - Journals

6. **Sale Module** - Sales Orders
   - Sale order creation and management
   - Order lines
   - Order states (draft, confirmed, shipped, done)
   - Partner linking

7. **Purchase Module** - Purchase Orders
   - Purchase order creation
   - Supplier management
   - Order confirmation and tracking

## Database Schema

### Core Tables (PHASE 1)
- `res_users` - User accounts
- `res_companies` - Companies
- `res_roles` - Access roles
- `res_user_roles` - User-Role mappings
- `res_partners` - Contacts (Customers/Suppliers/Contacts)
- `product_categories` - Product categories
- `product_products` - Product master
- `uom` - Units of Measure
- `stock_locations` - Warehouse locations
- `stock_moves` - Inventory movements
- `account_accounts` - Chart of Accounts
- `account_journals` - Accounting Journals
- `sale_orders` - Sales Orders
- `sale_order_lines` - Sales Order Lines
- `purchase_orders` - Purchase Orders
- `purchase_order_lines` - Purchase Order Lines
- `account_invoices` - Customer Invoices
- `account_invoice_lines` - Invoice Line Items

## API Endpoints

### Base Module
```
POST   /api/users                    - Create user
GET    /api/users                    - List users
GET    /api/users/:id                - Get user
PUT    /api/users/:id                - Update user
DELETE /api/users/:id                - Delete user
POST   /api/users/:id/roles/:roleId  - Assign role
GET    /api/users/:id/roles          - Get user roles

POST   /api/companies                - Create company
GET    /api/companies                - List companies
GET    /api/companies/:id            - Get company
PUT    /api/companies/:id            - Update company
DELETE /api/companies/:id            - Delete company
```

### Contacts Module
```
POST   /api/partners                 - Create partner
GET    /api/partners                 - List partners
GET    /api/partners/:id             - Get partner
PUT    /api/partners/:id             - Update partner
DELETE /api/partners/:id             - Delete partner
GET    /api/partners/type/customers  - Get customers
GET    /api/partners/type/suppliers  - Get suppliers
```

### Product Module
```
POST   /api/products                 - Create product
GET    /api/products                 - List products
GET    /api/products/:id             - Get product
GET    /api/products/code/:code      - Get by code
GET    /api/products/search/:term    - Search products
GET    /api/products/category/:categoryId - Get by category
PUT    /api/products/:id             - Update product
DELETE /api/products/:id             - Delete product
GET    /api/products/:id/variants    - Get variants
```

### Sale Module
```
POST   /api/sale-orders              - Create order
GET    /api/sale-orders              - List orders
GET    /api/sale-orders/:id          - Get order
GET    /api/sale-orders/partner/:partnerId - Get partner orders
PUT    /api/sale-orders/:id          - Update order
POST   /api/sale-orders/:id/confirm  - Confirm order
POST   /api/sale-orders/:id/cancel   - Cancel order
POST   /api/sale-orders/:id/lines    - Add line
GET    /api/sale-orders/:id/lines    - Get lines
PUT    /api/sale-orders/lines/:lineId - Update line
DELETE /api/sale-orders/lines/:lineId - Delete line
```

### Purchase Module
```
POST   /api/purchase-orders          - Create order
GET    /api/purchase-orders          - List orders
GET    /api/purchase-orders/:id      - Get order
GET    /api/purchase-orders/supplier/:supplierId - Get supplier orders
PUT    /api/purchase-orders/:id      - Update order
POST   /api/purchase-orders/:id/confirm - Confirm order
POST   /api/purchase-orders/:id/cancel - Cancel order
POST   /api/purchase-orders/:id/lines - Add line
GET    /api/purchase-orders/:id/lines - Get lines
PUT    /api/purchase-orders/lines/:lineId - Update line
DELETE /api/purchase-orders/lines/:lineId - Delete line
```

### Account Module
```
POST   /api/invoices                 - Create invoice
GET    /api/invoices                 - List invoices
GET    /api/invoices/:id             - Get invoice
GET    /api/invoices/reference/:ref  - Get by reference
GET    /api/invoices/partner/:partnerId - Get partner invoices
PUT    /api/invoices/:id             - Update invoice
POST   /api/invoices/:id/validate    - Validate invoice
POST   /api/invoices/:id/post        - Post invoice
POST   /api/invoices/:id/cancel      - Cancel invoice
POST   /api/invoices/:id/lines       - Add line
GET    /api/invoices/:id/lines       - Get lines
PUT    /api/invoices/lines/:lineId   - Update line
```

## Installation & Setup

### 1. Database Migration
```bash
# Apply PHASE 1 migrations
psql -U postgres -d your_database -f src/database/migrations/001_phase1_core.sql
```

### 2. Environment Variables
Add to `.env`:
```
DATABASE_URL=postgresql://user:password@localhost:5432/cajasimple
JWT_SECRET=your-secret-key-here
NODE_ENV=development
```

### 3. Start Server
```bash
npm install
npm start
# or for development
npm run dev
```

## Sample API Requests

### Create User
```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "login": "johndoe",
    "password": "secure123",
    "company_id": 1
  }'
```

### Create Sale Order
```bash
curl -X POST http://localhost:3000/api/sale-orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "partner_id": 1,
    "company_id": 1,
    "order_date": "2024-01-15",
    "currency_id": 1,
    "user_id": 1
  }'
```

### Add Product to Order
```bash
curl -X POST http://localhost:3000/api/sale-orders/1/lines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "product_id": 1,
    "quantity": 5,
    "price_unit": 100.00
  }'
```

## Coming Soon (PHASE 2+)

### Phase 2: Extended Features
- Point of Sale (POS)
- HR & Payroll
- CRM Module
- Email & Communications
- Advanced Reporting

### Phase 3: Advanced Features
- Manufacturing (MRP)
- Projects & Timesheet
- Quality Management
- Fleet Management

### Phase 4: Integrations
- Payment Gateways
- 3rd Party APIs
- Cloud Storage
- Email Marketing
- Live Chat Support

## Development Roadmap

| Phase | Timeline | Features | Status |
|-------|----------|----------|--------|
| 1 | Week 1-2 | Core modules | ✓ Done |
| 2 | Week 3-4 | POS, HR, CRM | 📅 Pending |
| 3 | Week 5+ | MRP, Projects | 📅 Pending |
| 4 | Week 6+ | Integrations | 📅 Pending |

## Performance Optimizations
- Database indexes on frequently queried fields
- Pagination support for all list endpoints
- Query optimization with SELECT-specific columns
- Connection pooling

## Security Features
- JWT-based authentication
- Role-based access control
- Password hashing with bcrypt
- SQL injection prevention via parameterized queries
- CORS protection

## Contributing
When adding new modules:
1. Create module folder under `src/modules/`
2. Define models in `models/`
3. Create routes in `routes/`
4. Add services in `services/`
5. Update `odooApi.js` with new routes
6. Document in this README

## License
MIT

## Support
For issues, contact the development team or check the documentation.
