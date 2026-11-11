mod account;
mod report;

use crate::account::{open, Account};
use report::summary;

/// Opens an account, pays into it and prints a summary.
fn main() {
    let mut account: Account = open("savings");
    account.deposit(50);
    println!("{}", summary(&account));
    println!("{}", report::format::line("done"));
}
