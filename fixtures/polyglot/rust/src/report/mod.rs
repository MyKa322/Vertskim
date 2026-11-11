pub mod format;

use crate::account::{Account, Describe};

/// One line about an account.
pub fn summary(account: &Account) -> String {
    format::line(&account.describe())
}
