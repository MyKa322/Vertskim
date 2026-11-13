using System.Collections.Generic;
using Acme.Pricing;

namespace Acme.Inventory;

/// <summary>What the warehouse currently holds.</summary>
public class Stock : IStock, Audited
{
    private readonly List<Item> items = new();

    /// <summary>Puts an item on the shelf.</summary>
    public void Add(Item item)
    {
        items.Add(item);
        Log("added");
    }

    public decimal Value()
    {
        decimal total = 0;
        foreach (var item in items)
        {
            total += PriceList.For(item) * item.Count;
        }
        return total;
    }

    private void Log(string message) { }

    public int Changes() => 0;
}
