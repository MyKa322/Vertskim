namespace Acme.Inventory
{
    /// <summary>Anything that holds items and knows their worth.</summary>
    public interface IStock
    {
        void Add(Item item);
        decimal Value();
    }

    /// <summary>Counts its own changes. An interface, though its name does not start with I.</summary>
    public interface Audited
    {
        int Changes();
    }

    /// <summary>A stocked product and how many of it there are.</summary>
    public record Item(string Sku, int Count);

    public enum Shelf
    {
        Front,
        Back,
    }
}
