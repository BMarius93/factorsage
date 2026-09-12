# Monitor configuration version

Adds `Monitor.configVersion`, the fence between a running scan cycle and a user rebinding the
Monitor to a different Strategy or Stock List.

A cycle loads a Monitor's binding at its start and can commit transition state and Signals seconds
later. Without a fence, a rebind landing in between would have its fresh configuration written into
by an evaluation of the configuration it just replaced. Every durable write the cycle makes is now
conditioned on this counter still holding the value the cycle loaded, taken under a `FOR SHARE` row
lock so a concurrent rebind either waits or is detected.

It is incremented **only** when `strategyId` or `stockListId` actually changes value — never by a
rename or an enable/disable, neither of which invalidates anything a cycle evaluated.

Backfill: `DEFAULT 0` is correct for every existing row. The column's only meaning is "has this
binding changed since the cycle read it", so any consistent starting value works, and existing
Monitors have never been rebound.
