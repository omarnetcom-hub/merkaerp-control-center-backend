# Odoo 19.0 Implementation - Developer Reference Guide

## Quick Start

### 1. Database Setup
```bash
# Apply migrations
psql -U postgres -d your_database -f src/database/migrations/001_phase1_core.sql
```

### 2. Environment Setup
```bash
# Copy environment template
cp backend/.env.example backend/.env

# Edit .env with your database credentials
DATABASE_URL=postgresql://user:password@localhost:5432/cajasimple
JWT_SECRET=your-secret-key
```

### 3. Install & Run
```bash
cd backend
npm install

# Apply the Odoo routes to server.js (see INTEGRATION_GUIDE.js)

npm start
# Server runs on http://localhost:8787
```

### 4. Test the API
```bash
# For Linux/Mac
bash test_api.sh

# For Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File test_api.ps1
```

---

## Module Architecture

### Base Module
**Location:** `src/modules/base/`

**Responsibilities:**
- User authentication & management
- Company management
- Role-based access control
- Multi-company support

**Models:**
- `User.js` - User account management
- `Company.js` - Company data management

**Routes:**
- `routes/users.js` - User CRUD endpoints
- `routes/companies.js` - Company CRUD endpoints

**Key Features:**
- JWT authentication
- Password hashing with bcrypt
- Role assignment
- User-company linking

---

### Contacts Module
**Location:** `src/modules/contacts/`

**Responsibilities:**
- Partner management (Customers, Suppliers, Contacts)
- Address management
- Contact categorization

**Models:**
- `Partner.js` - Partner/Contact management

**Routes:**
- `routes/partners.js` - Partner CRUD + filtering

**Key Features:**
- Partner type filtering (customer, supplier, contact)
- Search by email
- Bulk partner operations
- Address field support

---

### Product Module
**Location:** `src/modules/product/`

**Responsibilities:**
- Product catalog management
- Category management
- Product variants
- SKU/Code tracking
- Pricing & cost management

**Models:**
- `Product.js` - Product management

**Routes:**
- `routes/products.js` - Product CRUD + search

**Key Features:**
- Product search by name/code
- Category filtering
- Variant support
- Price and cost tracking
- Product categorization

---

### Stock Module
**Location:** `src/modules/stock/`

**Responsibilities:**
- Inventory management
- Stock location management
- Stock movement tracking
- Quantity tracking

**Models:**
- `Stock.js` - StockMove & Location classes

**Key Features:**
- Stock location management
- Incoming/outgoing/internal moves
- Move states (draft, waiting, confirmed, done)
- Quantity calculation by location

---

### Sale Module
**Location:** `src/modules/sale/`

**Responsibilities:**
- Sales order creation & management
- Order line management
- Order workflow states
- Customer linking

**Models:**
- `Sale.js` - SaleOrder & SaleOrderLine classes

**Routes:**
- `routes/orders.js` - Order CRUD + workflow

**Services:**
- `services/SaleOrderService.js` - Business logic

**Key Features:**
- Order states (draft, confirmed, shipped, done)
- Order line management
- Total calculation
- Order summary
- Customer order history

---

### Purchase Module
**Location:** `src/modules/purchase/`

**Responsibilities:**
- Purchase order management
- Supplier order tracking
- Order confirmation workflow

**Models:**
- `Purchase.js` - PurchaseOrder & PurchaseOrderLine classes

**Routes:**
- `routes/orders.js` - Order CRUD + workflow

**Key Features:**
- Purchase order states
- Supplier tracking
- Order confirmation
- Cost management

---

### Account Module
**Location:** `src/modules/account/`

**Responsibilities:**
- Invoice creation & management
- Chart of Accounts
- Accounting Journals
- Invoice workflow

**Models:**
- `Invoice.js` - Invoice & InvoiceLine classes

**Routes:**
- `routes/invoices.js` - Invoice CRUD + workflow

**Key Features:**
- Invoice types (out_invoice, in_invoice, out_refund, in_refund)
- Invoice states (draft, posted, paid, cancelled)
- Line item management
- Reference tracking
- Partner linking

---

## Data Models

### res_users
- User accounts with roles and permissions
- Authentication with bcrypt hashing
- Company assignment

### res_companies
- Multi-company support
- Company details (address, contact info)
- Currency and localization settings

### res_partners
- Customers, Suppliers, and Contacts
- Address information
- Contact categorization by type

### product_products
- Product master data
- SKU/Code tracking
- Price and cost management
- Product variants (parent-child relationship)

### stock_moves
- Inventory transactions
- Location tracking
- Movement types and states
- Product quantity updates

### sale_orders & sale_order_lines
- Customer orders
- Line items with products
- Order state workflow
- Total calculations

### purchase_orders & purchase_order_lines
- Supplier orders
- Line items
- Order confirmation
- Cost tracking

### account_invoices & account_invoice_lines
- Customer/Supplier invoices
- Invoice line items
- Invoice workflow (draft → posted → paid)
- Reference tracking

---

## Authentication

### JWT Flow
1. User logs in via `/api/auth/login`
2. Server returns JWT token
3. Client includes token in `Authorization: Bearer <token>` header
4. Server validates token on each request
5. Token expires after configured period (default: 7 days)

### Implementation
```javascript
// Middleware: src/middleware/auth.js
const token = req.headers.authorization?.split(' ')[1];
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = decoded;
```

---

## API Response Format

### Success Response
```json
{
  "id": 1,
  "name": "Example",
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

### Error Response
```json
{
  "error": "Error message",
  "status": 400
}
```

### List Response
```json
[
  { "id": 1, "name": "Item 1" },
  { "id": 2, "name": "Item 2" }
]
```

---

## Error Handling

### HTTP Status Codes
- `200` - OK
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `404` - Not Found
- `500` - Server Error

### Common Errors
- Missing required fields: 400
- Invalid authentication: 401
- Resource not found: 404
- Database errors: 500

---

## Performance Optimization

### Database Indexes
All major lookup fields have indexes:
- `res_users.email`
- `res_users.login`
- `res_partners.email`
- `product_products.code`
- `sale_orders.partner_id`
- `account_invoices.partner_id`
- etc.

### Query Optimization
- Use specific column selection (not SELECT *)
- Implement pagination for large datasets
- Use parameterized queries to prevent SQL injection

### Pagination Example
```bash
GET /api/products?limit=50&offset=100
```

---

## Adding New Modules

### Step 1: Create Module Structure
```
src/modules/new_module/
├── models/
│   └── Model.js
├── controllers/
├── services/
├── routes/
│   └── routes.js
└── migrations/
```

### Step 2: Create Model
```javascript
class MyModel {
  constructor(db) {
    this.db = db;
    this.table = 'my_table';
  }
  
  async create(data) { }
  async findById(id) { }
  async list() { }
  async update(id, data) { }
  async delete(id) { }
}
```

### Step 3: Create Routes
```javascript
const router = express.Router();

router.post('/', authMiddleware, async (req, res) => {
  // Create logic
});

module.exports = { router, setDatabase };
```

### Step 4: Register Routes
Update `src/routes/odooApi.js`:
```javascript
const myModuleRoutes = require('../modules/new_module/routes/routes');
myModuleRoutes.setDatabase(db);
app.use('/api/my-module', myModuleRoutes.router);
```

### Step 5: Create Migration
Add SQL schema to `src/database/migrations/`

---

## Testing

### Unit Tests (Coming Soon)
```bash
npm test
```

### API Tests
```bash
# Bash
bash test_api.sh

# PowerShell
powershell -ExecutionPolicy Bypass -File test_api.ps1
```

### Manual Testing with curl
```bash
# Create user
curl -X POST http://localhost:8787/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name":"Test","email":"test@example.com","login":"test","password":"123456"}'

# List users
curl http://localhost:8787/api/users \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Troubleshooting

### Connection Issues
```
Error: connect ECONNREFUSED 127.0.0.1:5432

Solution: Ensure PostgreSQL is running
psql -U postgres  # Test connection
```

### Authentication Errors
```
Error: Invalid token

Solution: Check JWT_SECRET in .env matches the token signing key
```

### Database Migration Errors
```
Error: relation "table_name" does not exist

Solution: Run migrations:
psql -U postgres -d database -f migrations/001_phase1_core.sql
```

### Module Loading Issues
```
Error: Cannot find module

Solution: Check require paths and ensure setDatabase is called
```

---

## Deployment

### Production Checklist
- [ ] Set NODE_ENV=production
- [ ] Generate strong JWT_SECRET
- [ ] Use environment variables for all secrets
- [ ] Enable HTTPS
- [ ] Configure CORS properly
- [ ] Set rate limiting
- [ ] Enable database backups
- [ ] Set up error logging
- [ ] Configure health checks

### Docker Deployment (Future)
- Dockerfile
- Docker Compose for database
- Container orchestration

---

## Support & Contribution

### Issues
- File issues in GitHub
- Include error logs
- Provide steps to reproduce

### Pull Requests
- Create feature branch
- Follow code style
- Add tests for new features
- Update documentation

---

## Resources

- [Odoo Documentation](https://www.odoo.com/documentation/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Express.js Guide](https://expressjs.com/)
- [JWT.io](https://jwt.io/)
- [OWASP Security Guidelines](https://owasp.org/)

---

## Changelog

### v1.0.0 (2024-01)
- ✓ Phase 1 Implementation
- ✓ Core modules (Base, Contacts, Product, Stock, Account, Sale, Purchase)
- ✓ Database schema
- ✓ RESTful API
- ✓ Authentication

### v2.0.0 (Coming Soon - Phase 2)
- □ POS Module
- □ HR Module
- □ CRM Module
- □ Reports & Analytics

---

**Last Updated:** January 2024
**Maintained By:** Development Team
**License:** MIT
