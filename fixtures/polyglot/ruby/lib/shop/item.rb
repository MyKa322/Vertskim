require_relative "priced"

module Shop
  # One product and its price in cents.
  class Item
    include Priced

    attr_reader :name

    def initialize(name, cents)
      @name = name
      @cents = cents
    end

    def price
      @cents
    end
  end
end
