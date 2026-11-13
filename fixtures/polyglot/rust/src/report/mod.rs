pub mod format;

use crate::account::{Account, Describe};

/// One line about an account.
pub fn summary(account: &Account) -> String {
    format::line(&account.describe())
}

impl Account {
    /// The account's line in a report: a method written in another module than its type.
    pub fn report_line(&self) -> String {
        summary(self)
    }
}
