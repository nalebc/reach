// Fictional data for isolated tests only. Never imported by the Reach server.
import { fail, isPlainRecord, hasReviewControls } from "../../server/core.mjs";

export const ORDER_INPUT = {
  type: "object",
  properties: {
    orderId: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[A-Za-z0-9_-]+$",
      description: "Order number",
    },
  },
  required: ["orderId"],
  additionalProperties: false,
};

export function orderInput(value) {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.orderId !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(value.orderId)
  )
    throw fail(
      400,
      "Enter one order number using letters, numbers, dashes or underscores.",
    );
  return { orderId: value.orderId };
}

// Explicit output projection: never return a provider response or its credentials.
export function orderResult(value, input) {
  if (
    !isPlainRecord(value) ||
    value.orderId !== input.orderId ||
    !["processing", "shipped", "delivered", "cancelled", "not_found"].includes(
      value.status,
    ) ||
    typeof value.summary !== "string" ||
    value.summary.length > 500 ||
    hasReviewControls(value.summary)
  )
    throw fail(502, "The service returned an invalid order status.");
  return {
    orderId: value.orderId,
    status: value.status,
    summary: value.summary,
  };
}

export const SAMPLE_STORE = Object.freeze({
  id: "sample_store",
  name: "Sample store",
  description:
    "Try a direct service tool with fictional orders. Free, no account or setup needed.",
  sample: true,
  account: "Built-in sample account",
  actions: [
    {
      id: "order_status",
      title: "Check order status",
      scope: "orders:read",
      permission: "Read order status",
      readOnly: true,
      inputSchema: ORDER_INPUT,
      example: { orderId: "DEMO-1001" },
      validate: orderInput,
      project: orderResult,
    },
  ],
  async run(_action, input, { signal }) {
    signal.throwIfAborted();
    const orders = {
      "DEMO-1001": {
        status: "shipped",
        summary: "Your sample desk lamp is on its way.",
      },
      "DEMO-1002": {
        status: "delivered",
        summary: "Your sample notebook was delivered.",
      },
    };
    return {
      orderId: input.orderId,
      ...(Object.hasOwn(orders, input.orderId)
        ? orders[input.orderId]
        : {
            status: "not_found",
            summary: "No sample order matches. Try DEMO-1001 or DEMO-1002.",
          }),
    };
  },
});

export const SERVICE_CONNECTORS = [SAMPLE_STORE];
