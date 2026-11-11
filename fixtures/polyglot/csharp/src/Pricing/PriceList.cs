using System;
using Acme.Inventory;

namespace Acme.Pricing;

/// <summary>Looks prices up by product code.</summary>
public static class PriceList
{
    public const decimal Default = 1.5m;

    /// <summary>The unit price of an item.</summary>
    public static decimal For(Item item)
    {
        return item.Sku.StartsWith("x", StringComparison.Ordinal) ? Default * 2 : Default;
    }
}
