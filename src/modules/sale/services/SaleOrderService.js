const { SaleOrder, SaleOrderLine } = require('../models/Sale');

class SaleOrderService {
  constructor(db) {
    this.db = db;
    this.saleOrder = new SaleOrder(db);
    this.saleOrderLine = new SaleOrderLine(db);
  }

  async createOrderWithLines(orderData, lines) {
    try {
      // Create order
      const order = await this.saleOrder.create(orderData);
      
      let totalAmount = 0;
      const createdLines = [];

      // Add lines to order
      for (const line of lines) {
        const lineData = {
          order_id: order.id,
          product_id: line.product_id,
          quantity: line.quantity,
          price_unit: line.price_unit,
          subtotal: line.quantity * line.price_unit
        };
        
        const createdLine = await this.saleOrderLine.create(lineData);
        createdLines.push(createdLine);
        totalAmount += createdLine.subtotal;
      }

      // Update order with total
      await this.saleOrder.update(order.id, { total_amount: totalAmount });

      return {
        order: { ...order, total_amount: totalAmount },
        lines: createdLines
      };
    } catch (error) {
      throw new Error(`Failed to create order: ${error.message}`);
    }
  }

  async confirmOrder(orderId) {
    try {
      const order = await this.saleOrder.confirm(orderId);
      
      // TODO: Create stock moves, generate invoice, etc.
      
      return order;
    } catch (error) {
      throw new Error(`Failed to confirm order: ${error.message}`);
    }
  }

  async calculateOrderTotal(orderId) {
    try {
      const lines = await this.saleOrderLine.getOrderLines(orderId);
      const total = lines.reduce((sum, line) => sum + (line.subtotal || 0), 0);
      
      await this.saleOrder.update(orderId, { total_amount: total });
      
      return total;
    } catch (error) {
      throw new Error(`Failed to calculate total: ${error.message}`);
    }
  }

  async getOrderSummary(orderId) {
    try {
      const order = await this.saleOrder.findById(orderId);
      const lines = await this.saleOrderLine.getOrderLines(orderId);
      
      return {
        ...order,
        lines,
        lineCount: lines.length,
        total: order.total_amount
      };
    } catch (error) {
      throw new Error(`Failed to get order summary: ${error.message}`);
    }
  }
}

module.exports = SaleOrderService;
