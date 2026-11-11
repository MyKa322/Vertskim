using Acme.Inventory;
using Xunit;

namespace Acme.Tests;

public class StockTests
{
    [Fact]
    public void AddsUp()
    {
        var stock = new Stock();
        stock.Add(new Item("a", 2));
        Assert.Equal(3m, stock.Value());
    }
}
