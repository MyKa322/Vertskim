#include <stdio.h>

#include "legacy.h"

static int units(int cents) { return cents / CENTS_PER_UNIT; }

void log_total(int cents) {
  printf("%d\n", units(cents));
}
