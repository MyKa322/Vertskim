use serde::Serialize;
use std::fmt;

/// The most an account may hold.
pub const LIMIT: u64 = 1_000;

/// What sort of account this is.
pub enum Kind {
    Current,
    Savings,
}

/// A named balance.
#[derive(Serialize)]
pub struct Account {
    pub name: String,
    balance: u64,
}

/// Anything that can describe itself in a line.
pub trait Describe {
    fn describe(&self) -> String;
}

impl Account {
    /// A new, empty account.
    pub fn new(name: &str) -> Self {
        Account { name: name.to_string(), balance: 0 }
    }

    /// Pays `amount` in, up to the limit.
    pub fn deposit(&mut self, amount: u64) {
        self.balance = (self.balance + amount).min(LIMIT);
        self.audit();
    }

    fn audit(&self) {}
}

impl Describe for Account {
    fn describe(&self) -> String {
        format!("{}: {}", self.name, self.balance)
    }
}

impl fmt::Display for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.describe())
    }
}

/// Opens an account under `name`.
pub fn open(name: &str) -> Account {
    Account::new(name)
}
