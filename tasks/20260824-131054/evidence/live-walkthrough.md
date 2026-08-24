# Cart totals now account for quantity and discounts, with a tax helper added

The cart calculation now multiplies each price by its quantity and applies an optional proportional discount to the resulting subtotal; a separate exported helper computes tax-inclusive amounts. The repository contains no tests, package metadata, or call sites, so the accepted ranges for quantity, discount, and tax rate—and whether tax should be integrated into cart totals—are not confirmed by the code.

:::walkthrough
version: 1
status: ready
revision: ed68c210cb28ba6b9b69cd54448b8d7dc9b54534
baseRevision: 516b086a7cfb6ece9a6bb326ed36ee669d70f085
files: 2
added: 6
removed: 3
:::

:::change
id: quantity-and-discount-total
importance: important
file: src/cart.js
lines: 1-7
:::

`total` now expects each item to carry a `quantity`, sums `price * quantity`, and subtracts a fraction of that subtotal using an optional `discount` (defaulting to zero). This confirms that quantity and discount both affect the result, and that the discount is applied after aggregation. It also changes compatibility with the former input shape: an item without `quantity` now makes the result `NaN`, whereas it previously contributed its price. No validation constrains negative quantities or discounts, discounts above `1`, or non-numeric values; whether those inputs should be rejected is unknown because no contract or tests are present.

```diff
@@ -1,7 +1,7 @@
-export function total(items) {
+export function total(items, discount = 0) {
   let sum = 0;
   for (const item of items) {
-    sum += item.price;
+    sum += item.price * item.quantity;
   }
-  return sum;
+  return sum - sum * discount;
 }
```

:::review
Does the caller contract guarantee a numeric `quantity` on every item and a fractional `discount` in the intended range, or should this function preserve the old item shape and/or validate those values?
:::

:::change
id: tax-inclusive-amount-helper
importance: supporting
file: src/tax.js
lines: 1-3
:::

The new `withTax` export returns an amount multiplied by `1 + rate`, treating `rate` as a decimal fraction. It is independent of `total` and has no repository call sites, so the code does not establish whether tax is intentionally a separate composition step or how invalid and out-of-range rates should behave.

```diff
@@ -0,0 +1,3 @@
+export function withTax(amount, rate) {
+  return amount * (1 + rate);
+}
```

:::review
Is the intended API a standalone decimal-rate helper that callers compose after discounts, including responsibility for validating `amount` and `rate`?
:::