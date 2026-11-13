import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { classifyFile } from "./discovery/classify.js";
import { Project } from "./project.js";
import { copyFixture, edge, removeTempDirs, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

/**
 * The polyglot fixture holds one small project per language. Each test names
 * the relationships that only come out right if that language's scoping rules
 * are followed.
 */
describe("Go, Rust, Java, C#, C and C++, Ruby, PHP and Luau", () => {
  let root: string;
  let project: Project;
  const node = (id: string) => project.node(id);
  const link = (src: string, kind: string, dst: string) => edge(project, src, kind, dst);
  const resolved = (src: string, kind: string, dst: string) =>
    assert.equal(link(src, kind, dst)?.confidence, "resolved", `${src} --${kind}--> ${dst}`);

  before(async () => {
    root = copyFixture("polyglot");
    project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
  });
  after(() => project.close());

  test("Go: a package is its directory, and methods live beside their type or apart from it", () => {
    const cart = "go/internal/cart";
    assert.equal(node(`${cart}/cart.go#Cart`)?.subkind, "struct");
    assert.equal(node(`${cart}/item.go#Pricer`)?.kind, "interface");
    assert.equal(node(`${cart}/item.go#Pricer.Price`)?.parent, `${cart}/item.go#Pricer`);
    assert.equal(node(`${cart}/total.go#Total`)?.exported, 1);
    assert.equal(node(`${cart}/total.go#applyTax`)?.exported, 0);
    assert.equal(node(`${cart}/total.go#Total`)?.doc, "Total is what the whole cart costs, tax included.");
    assert.equal(node(`${cart}/item.go#TaxRate`)?.signature, "const TaxRate = 20");

    // Same file as its type: listed under it. Another file: listed under that file.
    assert.equal(node(`${cart}/cart.go#Cart.Add`)?.parent, `${cart}/cart.go#Cart`);
    assert.equal(node(`${cart}/total.go#Cart.sum`)?.parent, `${cart}/total.go`);
    // Interfaces are satisfied without saying so: a guess from the method names and their shapes.
    const implemented = (type: string, iface: string) => link(type, "implements", iface)?.confidence;
    assert.equal(implemented(`${cart}/item.go#Item`, `${cart}/item.go#Pricer`), "heuristic");
    assert.equal(implemented(`${cart}/item.go#Item`, `${cart}/labels.go#Labeled`), "heuristic"); // embeds Pricer
    assert.equal(implemented(`${cart}/item.go#Item`, `${cart}/labels.go#Tagger`), undefined); // Label takes no prefix
    assert.equal(implemented(`${cart}/cart.go#Cart`, `${cart}/item.go#Pricer`), undefined);
    resolved(`${cart}/labels.go#Labeled`, "extends", `${cart}/item.go#Pricer`);
    // The type's outline shows both.
    const outline = project.details(node(`${cart}/cart.go#Cart`)!).outline.map((e) => e.node.id);
    assert.ok(outline.includes(`${cart}/cart.go#Cart.Add`));
    assert.ok(outline.includes(`${cart}/total.go#Cart.sum`));

    // No import between files of one package; the parameter's type says whose `sum` this is.
    resolved(`${cart}/total.go#Total`, "calls", `${cart}/total.go#Cart.sum`);
    resolved(`${cart}/total.go#Total`, "calls", `${cart}/total.go#applyTax`);
    resolved(`${cart}/total.go#applyTax`, "references", `${cart}/item.go#TaxRate`);
    // `c.record()` on the receiver reaches the embedded struct's method.
    resolved(`${cart}/cart.go#Cart`, "extends", `${cart}/cart.go#Audit`);
    resolved(`${cart}/cart.go#Cart.Add`, "calls", `${cart}/cart.go#Audit.record`);

    // An import names a package; the module path comes from go.mod.
    assert.equal(link("go/cmd/shop/main.go", "imports", "go/internal/cart/")?.confidence, "exact");
    assert.ok(link("go/cmd/shop/main.go", "imports", "ext:go/fmt"));
    resolved("go/cmd/shop/main.go#main", "calls", `${cart}/cart.go#New`);
    resolved("go/cmd/shop/main.go#main", "calls", `${cart}/total.go#Total`);
    resolved("go/cmd/shop/main.go#main", "calls", "go/internal/format/money.go#Money"); // imported under an alias
    // `c := cart.New()`: the type of `c` is what `func New() *Cart` returns.
    resolved("go/cmd/shop/main.go#main", "calls", `${cart}/cart.go#Cart.Add`);

    // A test in the same package imports nothing, so its subjects come from what it uses.
    assert.equal(project.store.getFile(`${cart}/cart_test.go`)?.subkind, "test");
    assert.ok(link(`${cart}/cart_test.go`, "tests", `${cart}/total.go`));
    assert.ok(link(`${cart}/cart_test.go`, "tests", `${cart}/cart.go`));
    assert.equal(project.store.getFile(`${cart}/cart.go`)?.package, "cart");
  });

  test("Rust: modules follow files, impl blocks give a type its methods", () => {
    const account = "rust/src/account.rs";
    assert.equal(node(`${account}#Account`)?.subkind, "struct");
    assert.equal(node(`${account}#Describe`)?.kind, "interface");
    assert.equal(node(`${account}#Kind`)?.subkind, "enum");
    assert.equal(node(`${account}#Account.deposit`)?.parent, `${account}#Account`);
    assert.equal(node(`${account}#Account.deposit`)?.doc, "Pays `amount` in, up to the limit.");
    assert.equal(node(`${account}#Account`)?.doc, "A named balance."); // the comment sits above an attribute
    assert.equal(node(`${account}#Account.audit`)?.exported, 0);
    assert.equal(node(`${account}#Account.describe`)?.exported, 1); // public through the trait

    resolved(`${account}#Account`, "implements", `${account}#Describe`);
    resolved(`${account}#Account.deposit`, "calls", `${account}#Account.audit`);
    resolved(`${account}#Account.deposit`, "references", `${account}#LIMIT`);
    resolved(`${account}#open`, "calls", `${account}#Account.new`);

    // `mod account;` and `use crate::account::{open, Account}` both lead to the file.
    assert.ok(link("rust/src/main.rs", "imports", account));
    assert.ok(link("rust/src/main.rs", "imports", "rust/src/report/mod.rs"));
    assert.ok(link("rust/src/report/mod.rs", "imports", "rust/src/report/format.rs"));
    assert.ok(link(account, "imports", "ext:cargo/serde"));
    assert.ok(link(account, "imports", "ext:rust/std"));
    resolved("rust/src/main.rs#main", "calls", `${account}#open`);
    resolved("rust/src/main.rs#main", "calls", `${account}#Account.deposit`); // `let mut account: Account`
    resolved("rust/src/report/mod.rs#summary", "calls", `${account}#Account.describe`); // `account: &Account`
    resolved("rust/src/report/mod.rs#summary", "calls", "rust/src/report/format.rs#line"); // `format::line`
    // `use super::line` inside an inline `mod tests` means this file; `assert_eq!(line("a"), …)` calls it.
    resolved("rust/src/report/format.rs#wraps", "calls", "rust/src/report/format.rs#line");
    // Calls inside a macro's arguments are read from its tokens.
    resolved("rust/src/main.rs#main", "calls", "rust/src/report/mod.rs#summary"); // println!("{}", summary(&account))
    resolved("rust/src/main.rs#main", "calls", "rust/src/report/format.rs#line"); // report::format::line("done")
    resolved(`${account}#Account.fmt`, "calls", `${account}#Account.describe`); // write!(f, "{}", self.describe())
    // An `impl` block in another module of the crate: the method is in the type's outline.
    const outline = project.details(node(`${account}#Account`)!).outline.map((e) => e.node.id);
    assert.ok(outline.includes("rust/src/report/mod.rs#Account.report_line"));
    assert.ok(outline.includes(`${account}#Account.deposit`));
    assert.equal(link("rust/src/main.rs#main", "references", "rust/src/report/mod.rs#summary"), null);
  });

  test("C and C++: includes are transitive, and uses of a declaration reach its definition", () => {
    const header = "cpp/include/shop/cart.hpp";
    const item = "cpp/include/shop/item.hpp";
    const source = "cpp/src/cart.cpp";
    assert.equal(node(`${header}#Cart`)?.doc, "A basket of items.");
    assert.equal(node(`${header}#Cart.add`)?.subkind, "declaration");
    assert.equal(node(`${header}#Cart.add`)?.exported, 1);
    assert.equal(node(`${header}#Cart.audit`)?.exported, 0); // under `private:`
    assert.equal(node(`${item}#Item`)?.subkind, "struct");
    assert.equal(node(`${source}#Cart.add`)?.kind, "method"); // `void Cart::add(...)`, written apart
    assert.equal(node("cpp/src/legacy.c#units")?.exported, 0); // static
    assert.equal(node("cpp/src/legacy.h#CENTS_PER_UNIT")?.subkind, "macro");
    assert.equal(node("cpp/src/legacy.h#LEGACY_H"), null); // a header guard

    // A quoted include is found beside the file or anywhere its path fits; <...> is a library.
    assert.equal(link("cpp/src/main.cpp", "imports", header)?.confidence, "exact");
    assert.ok(link(header, "imports", item));
    assert.ok(link("cpp/src/main.cpp", "imports", "ext:c/std"));
    resolved(`${header}#Cart`, "extends", `${item}#Priced`);
    // `cart.add(...)` on `shop::Cart cart` reaches the definition in the source file, not the header.
    resolved("cpp/src/main.cpp#main", "calls", `${source}#Cart.add`);
    resolved("cpp/src/main.cpp#main", "calls", "cpp/src/legacy.c#log_total"); // C, declared in legacy.h
    resolved(`${source}#Cart.add`, "calls", `${source}#Cart.audit`); // a bare call to its own member
    // `with_tax` is declared in item.hpp, which cart.cpp reaches only through cart.hpp.
    resolved(`${source}#Cart.total`, "calls", `${source}#with_tax`);
    const outline = project.details(node(`${header}#Cart`)!).outline.map((e) => e.node.id);
    assert.ok(outline.includes(`${source}#Cart.total`));
  });

  test("Ruby: constants are global, modules reopen, and bare names call methods", () => {
    const cart = "ruby/lib/shop/cart.rb";
    const item = "ruby/lib/shop/item.rb";
    assert.equal(node(`${cart}#Shop.Cart`)?.doc, "A basket of items."); // the comment is parsed inside `module Shop`
    assert.equal(node(`${cart}#Shop`)?.signature, "module Shop");
    assert.equal(node(`${cart}#Shop.Cart.open`)?.subkind, "static"); // def self.open
    assert.equal(node(`${cart}#Shop.Cart.audit`)?.exported, 0); // after a bare `private`
    assert.equal(node(`${cart}#Shop.Cart.add`)?.exported, 1);
    assert.equal(node("ruby/lib/shop/priced.rb#Shop.Priced")?.subkind, "module");

    assert.equal(link("ruby/bin/shop.rb", "imports", "ruby/lib/shop.rb")?.confidence, "exact"); // require_relative
    assert.ok(link("ruby/lib/shop.rb", "imports", "ext:gem/json"));
    assert.ok(link("ruby/test/cart_test.rb", "tests", cart));
    resolved(`${item}#Shop.Item`, "extends", "ruby/lib/shop/priced.rb#Shop.Priced"); // include Priced
    resolved(`${cart}#Shop.Cart.add`, "calls", `${cart}#Shop.Cart.audit`); // `audit`, no parentheses
    // `Shop::Cart.open` from a file that only requires lib/shop.rb.
    resolved("ruby/bin/shop.rb", "calls", `${cart}#Shop.Cart.open`);
    // `cart = Shop::Cart.new` types the variable.
    resolved("ruby/test/cart_test.rb#CartTest.test_total", "calls", `${cart}#Shop.Cart.add`);
    resolved("ruby/test/cart_test.rb#CartTest.test_total", "calls", `${item}#Shop.Item`); // Shop::Item.new
    // A block parameter has no type: a guess, marked as one.
    assert.equal(
      link(`${cart}#Shop.Cart.total`, "calls", "ruby/lib/shop/priced.rb#Shop.Priced.with_tax")?.confidence,
      "heuristic",
    );
  });

  test("Luau: a table given functions is a class, and a module is what it returns", () => {
    const shop = "luau/src/shop";
    const cart = `${shop}/Cart.luau`;
    const item = `${shop}/Item.luau`;
    const main = "luau/src/main.server.luau";
    assert.equal(node(`${cart}#Cart`)?.kind, "class");
    assert.equal(node(`${cart}#Cart`)?.exported, 2); // return Cart
    assert.equal(node(`${cart}#Cart~2`), null); // `export type Cart` beside it is the same thing, not a second node
    assert.equal(node(`${cart}#Cart`)?.doc, "A shopping cart: items, and what they cost together.");
    assert.equal(node(`${item}#Item`)?.doc, "One line of a cart: a thing and how many of it."); // --[=[ @class Item … ]=]
    assert.equal(node(`${cart}#Cart.add`)?.signature, "function Cart:add(item: Item.Item): Cart");
    assert.equal(node(`${cart}#Cart.new`)?.subkind, "static"); // a dot, and no `self`
    assert.equal(node(`${cart}#Cart.add`)?.subkind, null);
    assert.equal(node(`${cart}#Cart._audit`)?.exported, 0);

    // `require` by path, by place in the game (the Rojo project says where that is), and by alias (.luaurc).
    assert.equal(link(cart, "imports", item)?.confidence, "exact");
    assert.ok(link(cart, "imports", `${shop}/Support/Tax.luau`)); // script.Parent.Support.Tax
    assert.ok(link(main, "imports", cart)); // ReplicatedStorage.Shop.Cart
    assert.ok(link(main, "imports", `${shop}/init.luau`)); // ReplicatedStorage.Shop, a folder
    assert.ok(link(`${shop}/Cart.spec.luau`, "imports", cart)); // @shop/Cart
    assert.ok(link(`${shop}/Cart.spec.luau`, "tests", cart));
    // A Roblox service and an installed package are not the project's.
    assert.ok(link(main, "imports", "ext:roblox/Players"));
    assert.ok(link(main, "imports", "ext:wally/Signal"));
    assert.equal(node(`${main}#Players`), null);

    // A metatable's `__index` is the base class, and its methods are found through it.
    resolved(`${item}#Item`, "extends", `${shop}/Priced.luau#Priced`);
    resolved(`${item}#Item.label`, "calls", `${shop}/Priced.luau#Priced.describe`); // self:describe()
    resolved(`${cart}#Cart.total`, "calls", `${cart}#Cart.subtotal`); // self:subtotal()
    resolved(`${cart}#Cart.add`, "calls", `${item}#Item.label`); // item: Item.Item
    resolved(`${cart}#Cart.lastLabel`, "calls", `${item}#Item.label`); // self.last, set from that parameter
    resolved(`${main}#checkout`, "calls", `${cart}#Cart.total`); // cart: Cart.Cart
    resolved(`${main}#greet`, "calls", `${cart}#Cart.add`); // local cart = Cart.new()
    // A module that returns a table of its functions, and one that hands other modules on.
    resolved(`${cart}#Cart.total`, "calls", `${shop}/Support/Tax.luau#withTax`);
    assert.equal(node(`${shop}/Support/Tax.luau#withTax`)?.exported, 1);
    assert.equal(node(`${shop}/Support/Tax.luau#round`)?.exported, 0);
    resolved(`${main}#greet`, "calls", `${item}#Item.new`); // Shop.Item.new()
    resolved(`${main}#greet`, "calls", "luau/legacy/account.lua#Account.open"); // Lua and Luau share a family
    // A loop variable has no type: a guess, marked as one.
    assert.equal(link(`${cart}#Cart.subtotal`, "calls", `${item}#Item.price`)?.confidence, "heuristic");
    // Nothing is guessed for what is called on a service or on an installed package's value.
    const fromMain = project.store.db.prepare("SELECT dst FROM edges WHERE src = ? AND kind = 'calls'").all(main);
    assert.deepEqual(fromMain, []);

    // Lua as it was written before Luau: a global table, a module named with dots.
    assert.equal(node("luau/legacy/account.lua#Account")?.kind, "class");
    assert.equal(node("luau/legacy/account.lua#Account")?.language, "lua");
    assert.ok(link("luau/legacy/account.lua", "imports", "luau/legacy/ledger.lua")); // require("legacy.ledger")
    resolved("luau/legacy/account.lua#Account.deposit", "calls", "luau/legacy/ledger.lua#M.record");
    assert.deepEqual(
      project.status().syntaxErrors.filter((file) => file.path.startsWith("luau/")),
      [],
    );
  });

  test("PHP: namespaces are in scope, use imports a class, typed properties settle calls", () => {
    const cart = "php/src/Cart.php";
    assert.equal(node(`${cart}#Cart`)?.doc, "A basket of items.");
    assert.equal(node(`${cart}#Cart.audit`)?.exported, 0); // private
    assert.equal(node(`${cart}#Cart.open`)?.subkind, "static");
    assert.equal(node(`${cart}#Cart.__construct`)?.subkind, "constructor");
    assert.equal(node("php/src/Priced.php#Priced")?.kind, "interface");
    assert.equal(project.store.getFile(cart)?.package, "Acme\\Shop");

    // `use Acme\Shop\Support\Tax;` finds the file declaring that namespace and named after the class.
    assert.equal(link(cart, "imports", "php/src/Support/Tax.php")?.confidence, "exact");
    assert.ok(link(cart, "imports", "ext:composer/psr"));
    resolved("php/src/Item.php#Item", "implements", "php/src/Priced.php#Priced"); // same namespace, no `use`
    resolved(`${cart}#Cart.add`, "calls", `${cart}#Cart.audit`); // $this->audit()
    resolved(`${cart}#Cart.total`, "calls", "php/src/Support/Tax.php#Tax.apply"); // through `private Tax $tax`
    resolved(`${cart}#Cart.__construct`, "calls", "php/src/Support/Tax.php#Tax"); // new Tax()
    resolved("php/bin/shop.php", "calls", `${cart}#Cart.open`); // Cart::open()
    resolved("php/bin/shop.php", "calls", "php/bin/shop.php#format_total");
  });

  test("Java: the package is in scope, declared types settle calls, super and this work", () => {
    const billing = "java/src/main/java/com/acme/billing";
    const money = "java/src/main/java/com/acme/util/Money.java";
    assert.equal(node(`${billing}/Invoice.java#Invoice`)?.signature, "public class Invoice implements Payable");
    assert.equal(node(`${billing}/Invoice.java#Invoice.total`)?.signature, "public Money total()"); // no @Override
    assert.equal(node(`${billing}/Invoice.java#Invoice`)?.doc, "A bill made of lines.");
    assert.equal(node(`${money}#Money.Money`)?.subkind, "constructor");
    assert.equal(node(`${money}#Money.Money`)?.exported, 0);
    assert.equal(node(`${money}#Money.Currency`)?.subkind, "enum");
    assert.equal(node(`${billing}/RecurringInvoice.java#RecurringInvoice.MONTHS`)?.kind, "variable");

    resolved(`${billing}/Invoice.java#Invoice`, "implements", `${billing}/Payable.java#Payable`);
    resolved(`${billing}/RecurringInvoice.java#RecurringInvoice`, "extends", `${billing}/Invoice.java#Invoice`);
    // `Money sum`, `for (Line line : lines)`: the declared type decides, so nothing is a guess.
    resolved(`${billing}/Invoice.java#Invoice.total`, "calls", `${money}#Money.zero`);
    resolved(`${billing}/Invoice.java#Invoice.total`, "calls", `${money}#Money.plus`);
    resolved(`${billing}/Invoice.java#Invoice.total`, "calls", `${billing}/Line.java#Line.amount`);
    // `lines.add(...)` is on a java.util.List, which is not ours: no edge to Invoice.add.
    assert.equal(link(`${billing}/Invoice.java#Invoice.add`, "calls", `${billing}/Invoice.java#Invoice.add`), null);
    resolved(
      `${billing}/RecurringInvoice.java#RecurringInvoice.yearly`,
      "calls",
      `${billing}/Invoice.java#Invoice.total`,
    ); // super.total()
    resolved(
      `${billing}/RecurringInvoice.java#RecurringInvoice.isEmpty`,
      "calls",
      `${billing}/Invoice.java#Invoice.count`,
    ); // this.count(), inherited

    assert.ok(link(`${billing}/Invoice.java`, "imports", money));
    assert.ok(link(`${billing}/Invoice.java`, "imports", "ext:jvm/java.util"));
    assert.ok(link(`${billing}/RecurringInvoice.java`, "imports", "java/src/main/java/com/acme/util/")); // import com.acme.util.*

    // The test sits in another source tree but the same package.
    const test_ = "java/src/test/java/com/acme/billing/InvoiceTest.java";
    assert.equal(project.store.getFile(test_)?.subkind, "test");
    assert.ok(link(test_, "tests", `${billing}/Invoice.java`));
    resolved(`${test_}#InvoiceTest.totalsItsLines`, "calls", `${billing}/Invoice.java#Invoice.add`);
    resolved(`${test_}#InvoiceTest.totalsItsLines`, "calls", `${billing}/Invoice.java#Invoice.count`);
    assert.ok(link(test_, "imports", "ext:jvm/org.junit"));
  });

  test("C#: namespaces bring types into scope, bare calls reach the class's own methods", () => {
    const stock = "csharp/src/Inventory/Stock.cs";
    const istock = "csharp/src/Inventory/IStock.cs";
    const prices = "csharp/src/Pricing/PriceList.cs";
    assert.equal(node(`${stock}#Stock`)?.doc, "What the warehouse currently holds.");
    assert.equal(node(`${stock}#Stock.Log`)?.exported, 0);
    assert.equal(node(`${istock}#Item`)?.subkind, "record");
    assert.equal(node(`${istock}#Shelf`)?.subkind, "enum");
    assert.equal(node(`${istock}#IStock.Add`)?.exported, 1);
    assert.equal(node(`${prices}#PriceList.Default`)?.subkind, "const");
    assert.equal(project.store.getFile(stock)?.package, "Acme.Inventory");

    resolved(`${stock}#Stock`, "implements", `${istock}#IStock`);
    // What the base turns out to be decides, not the I in its name.
    resolved(`${stock}#Stock`, "implements", `${istock}#Audited`);
    assert.equal(link(`${stock}#Stock`, "extends", `${istock}#Audited`), null);
    resolved(`${stock}#Stock.Add`, "calls", `${stock}#Stock.Log`); // bare call
    resolved(`${stock}#Stock.Value`, "calls", `${prices}#PriceList.For`); // through `using Acme.Pricing`
    resolved(`${stock}#Stock.Add`, "references", `${istock}#Item`); // same namespace, other file
    assert.ok(link(stock, "imports", "csharp/src/Pricing/"));
    assert.ok(link(stock, "imports", "ext:dotnet/System"));

    const tests = "csharp/tests/StockTests.cs";
    resolved(`${tests}#StockTests.AddsUp`, "calls", `${stock}#Stock.Add`); // var stock = new Stock()
    resolved(`${tests}#StockTests.AddsUp`, "calls", `${stock}#Stock.Value`);
    assert.ok(link(tests, "tests", stock));
    assert.ok(link(tests, "imports", "ext:dotnet/Xunit"));
  });

  test("languages keep to themselves", () => {
    // Calls stay in their language family: C/C++ share headers, and Lua/Luau share modules.
    const rows = project.store.db
      .prepare(
        `SELECT a.language AS src, b.language AS dst FROM edges e
         JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst
         WHERE e.kind = 'calls' AND a.language != b.language
           AND NOT (a.language IN ('c', 'cpp') AND b.language IN ('c', 'cpp'))
           AND NOT (a.language IN ('lua', 'luau') AND b.language IN ('lua', 'luau'))`,
      )
      .all();
    assert.deepEqual(rows, []);
    const found = project.search({ query: "deposit" }).hits.map((h) => h.node.id);
    assert.ok(found.includes("rust/src/account.rs#Account.deposit"));
  });

  test("changes are picked up without re-linking everything", async () => {
    const cart = "go/internal/cart";
    write(root, `${cart}/discount.go`, "package cart\n\nfunc discount(cents int) int {\n\treturn cents / 10\n}\n", 1);
    const total = readFileSync(join(root, `${cart}/total.go`), "utf8");
    write(
      root,
      `${cart}/total.go`,
      total.replace("return applyTax(c.sum())", "return applyTax(c.sum() - discount(c.sum()))"),
      1,
    );
    const added = await project.sync();
    assert.ok(added.resolvedFiles < 12, `re-linked ${added.resolvedFiles} files`);
    resolved(`${cart}/total.go#Total`, "calls", `${cart}/discount.go#discount`);

    rmSync(join(root, `${cart}/discount.go`));
    await project.sync();
    assert.equal(link(`${cart}/total.go#Total`, "calls", `${cart}/discount.go#discount`), null);
    resolved(`${cart}/total.go#Total`, "calls", `${cart}/total.go#applyTax`);

    // Renaming the module in go.mod changes what every import means.
    write(root, "go/go.mod", "module example.com/other\n\ngo 1.22\n", 2);
    await project.sync();
    assert.equal(link("go/cmd/shop/main.go", "imports", "go/internal/cart/"), null);
    assert.ok(link("go/cmd/shop/main.go", "imports", "ext:go/example.com/shop/internal"));
  });

  test("Luau: a module that appears later is found by those already asking for it", async () => {
    const shop = "luau/src/shop";
    const coupon = `${shop}/Coupon.luau`;
    write(
      root,
      coupon,
      'local Discount = require("./Support/Discount")\n\nlocal function apply(cents: number): number\n\treturn Discount.off(cents)\nend\n\nreturn { apply = apply }\n',
      3,
    );
    await project.sync();
    assert.equal(link(coupon, "imports", `${shop}/Support/Discount/init.luau`), null);

    // A folder with an `init` file is a module by the folder's name.
    write(
      root,
      `${shop}/Support/Discount/init.luau`,
      "local Discount = {}\n\nfunction Discount.off(cents: number): number\n\treturn cents // 10\nend\n\nreturn Discount\n",
      3,
    );
    const added = await project.sync();
    assert.ok(added.resolvedFiles < 12, `re-linked ${added.resolvedFiles} files`);
    assert.ok(link(coupon, "imports", `${shop}/Support/Discount/init.luau`));
    resolved(`${coupon}#apply`, "calls", `${shop}/Support/Discount/init.luau#Discount.off`);
  });
});

describe("Luau import configuration", () => {
  test("replaces old resolutions when aliases or the Rojo tree change or disappear", async () => {
    const root = tempDir("luau-config");
    for (const folder of ["first", "second"]) {
      write(root, `${folder}/Item.luau`, "local Item = {}\nfunction Item.new() return {} end\nreturn Item\n", 1);
    }
    write(
      root,
      "main.luau",
      'local Alias = require("@items/Item")\nlocal Game = require(game.ReplicatedStorage.Shared.Item)\nlocal function fromAlias() return Alias.new() end\nlocal function fromGame() return Game.new() end\nreturn { fromAlias = fromAlias, fromGame = fromGame }\n',
      1,
    );
    const alias = (folder: string, tick: number) =>
      write(root, ".luaurc", JSON.stringify({ aliases: { items: folder } }), tick);
    const rojo = (folder: string, tick: number) =>
      write(
        root,
        "game.project.json",
        JSON.stringify({ tree: { ReplicatedStorage: { Shared: { $path: folder } } } }),
        tick,
      );
    alias("first", 1);
    rojo("first", 1);
    const project = Project.open({ root, dataDir: tempDir("data") });
    const called = (name: string, folder: string) =>
      edge(project, `main.luau#${name}`, "calls", `${folder}/Item.luau#Item.new`);
    try {
      await project.sync();
      assert.equal(called("fromAlias", "first")?.confidence, "resolved");
      assert.equal(called("fromGame", "first")?.confidence, "resolved");
      alias("second", 2);
      await project.sync({ paths: [".luaurc"] });
      assert.equal(called("fromAlias", "first"), null);
      assert.equal(called("fromAlias", "second")?.confidence, "resolved");
      rojo("second", 2);
      await project.sync({ paths: ["game.project.json"] });
      assert.equal(called("fromGame", "first"), null);
      assert.equal(called("fromGame", "second")?.confidence, "resolved");
      rmSync(join(root, ".luaurc"));
      rmSync(join(root, "game.project.json"));
      await project.sync({ paths: [".luaurc", "game.project.json"] });
      assert.equal(called("fromAlias", "second"), null);
      assert.equal(called("fromGame", "second"), null);
    } finally {
      await project.close();
    }
  });
});

describe("test files are recognised by each language's convention", () => {
  test("by name and by folder", () => {
    assert.equal(classifyFile("src/main/java/com/acme/InvoiceTest.java"), "test");
    assert.equal(classifyFile("src/main/java/com/acme/Contest.java"), "source");
    assert.equal(classifyFile("src/Billing/StockTests.cs"), "test");
    assert.equal(classifyFile("internal/cart/cart_test.go"), "test");
    assert.equal(classifyFile("src/parser_test.rs"), "test");
    assert.equal(classifyFile("tests/integration.rs"), "test");
    assert.equal(classifyFile("src/account.rs"), "source");
    assert.equal(classifyFile("src/shop/Cart.spec.luau"), "test");
    assert.equal(classifyFile("src/shop/Cart.test.lua"), "test");
    assert.equal(classifyFile("src/shop/Cart.server.luau"), "source");
  });
});
