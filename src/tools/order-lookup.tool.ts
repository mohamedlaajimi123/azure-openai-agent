export const ORDER_LOOKUP_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'lookupOrder',
    description: 'Looks up current order status, item details, and expected delivery date by order ID.',
    parameters: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'The unique order identifier, e.g., 123 or 42',
        },
      },
      required: ['orderId'],
    },
  },
};

const MOCK_ORDERS_DB: Record<string, { status: string; item: string; deliveryDate: string }> = {
  '123': { status: 'Shipped', item: 'Azure Cloud Practitioner Guide', deliveryDate: 'Tomorrow by 5 PM' },
  '42': { status: 'Processing', item: 'Wireless Mechanical Keyboard', deliveryDate: 'Friday, Sep 18' },
};

export function executeOrderLookup(orderId: string) {
  const order = MOCK_ORDERS_DB[orderId];
  if (!order) {
    return JSON.stringify({ error: `Order #${orderId} not found.` });
  }
  return JSON.stringify({ orderId, ...order });
}