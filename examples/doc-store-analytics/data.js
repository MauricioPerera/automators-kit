/**
 * Deterministic seed data for the doc-store-analytics example — no
 * Math.random, so the same `n` always produces the same catalog and the
 * same reports (reproducible demo/tests).
 */

const CATEGORIES = ['electronics', 'kitchen', 'outdoors', 'books', 'toys'];
const ADJECTIVES = ['compact', 'premium', 'budget', 'rugged', 'wireless'];

/**
 * @param {number} n
 * @returns {Array<{sku: string, name: string, category: string, price: number, stock: number}>}
 */
export function generateProducts(n) {
  const products = [];
  for (let i = 0; i < n; i++) {
    const category = CATEGORIES[i % CATEGORIES.length];
    const adj = ADJECTIVES[Math.floor(i / CATEGORIES.length) % ADJECTIVES.length];
    products.push({
      sku: `SKU-${1000 + i}`,
      name: `${adj} ${category} item ${i}`,
      category,
      price: 10 + (i % 50) * 3.5,
      stock: (i * 7) % 40, // deterministic spread, some land at/near 0 (low stock)
    });
  }
  return products;
}

/**
 * @param {Array<{_id: string}>} products - already-inserted products (with real _id)
 * @param {number} n
 * @returns {Array<{productId: string, qty: number, customerEmail: string}>}
 */
export function generateOrders(products, n) {
  const orders = [];
  for (let i = 0; i < n; i++) {
    // Skew toward the first few products so "top sellers" is meaningful,
    // not uniformly flat.
    const productIdx = Math.floor((i % 10) < 6 ? i % 5 : i % products.length);
    const product = products[productIdx % products.length];
    orders.push({
      productId: product._id,
      qty: 1 + (i % 5),
      customerEmail: `customer${i % 20}@example.com`,
    });
  }
  return orders;
}
