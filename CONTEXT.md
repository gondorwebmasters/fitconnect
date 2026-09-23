# Fitconnect Backend

Domain glossary and terms for the Fitconnect backend system.

## Language

**Schedule**:
A planned session or class at a gym/company, which has a specific capacity (maximum users) and an assigned administrator.
A schedule cannot be deleted if it has registered users or users on the waitlist; in such cases, it is _cancelled_ (deactivated but preserved in history) instead of physically deleted. Past schedules are also preserved and never deleted automatically when their recurring template (Schedule Programmed) is removed.

**Schedule Programmed (Programación Semanal)**:
A weekly recurring template that defines the days of the week, hours, capacity, and administrator (coach) for a type of session. It serves as the baseline to automatically spawn individual Schedule instances for future weeks.

**Schedule Options**:
Settings configured per company/gym that dictate rules for booking, capacity requirements, and administrative warnings.

**Quota Warning Thresholds**:
An array of percentage values representing capacity levels at which schedule administrators receive warning notifications.

**Notified Quota Thresholds**:
An array of threshold percentages stored on a schedule to track which quota warnings have already been sent to avoid duplicate notifications.

**Waitlist (Lista de espera)**:
A list of users waiting to join a schedule when its maximum capacity has been reached. When a slot becomes available, the first user in the waitlist is promoted, subject to business logic validation.

**Future Subscription (Suscripción Futura)**:
A subscription created from scratch with a start date (startDate) set in the future. It is saved in the database as ACTIVE or TRIALING, but the user cannot access its permissions until the start date is reached, due to current period validation filters.
A user/company can have at most one Future Subscription scheduled at any time, and its start date must be strictly after the current active subscription's period end. When a Future Subscription is scheduled, the current active subscription is automatically set to cancel at the end of its period to prevent renewal conflicts.

**Subscription State (subscriptionState)**:
A derived, mutually-exclusive access state computed **per member, per active company** and returned on the auth payload (login / getMe → `buildAuthResponseWithPermissions`). It answers "why can/can't this member access the gym?" and drives the informational banner in the mobile app. It is derived, never stored. Four states:

- `ACTIVE` — a currently-active subscription row exists (`hasActive: true`). Full access; no banner.
- `SCHEDULED` — no currently-active row, but a future-dated ACTIVE/TRIALING row exists (a Future Subscription, or a brand-new member whose sub has not started). No access yet; banner reads "your subscription starts on {startDate}". SCHEDULED takes precedence over EXPIRED.
- `EXPIRED` — no active row and no future row, but at least one past subscription row exists. No access; banner reads "your subscription has expired".
- `NONE` — no subscription rows at all (never subscribed). No banner.

Only computed for the **member** role; coaches, admins, and super-admins are always `ACTIVE`/`NONE` and never trip the banner. `hasActive` remains the single gate for access; `subscriptionState` is additive and only distinguishes *why* access is absent.

**Backdated Subscription (Suscripción Retroactiva)**:
A subscription created with a **past** `startDate`. Only permitted for **free plans** (`plan.amount === 0`) — on this platform a free plan models a **cash/manual membership** the administrator settles off-platform (the member pays in efectivo), so backdating lets the admin record a membership from the day the member actually started using the gym instead of gifting those already-used days. Because the period end is computed from the backdated start (`calculatePeriodEnd(startDate, plan)`), the elapsed days are absorbed by the member — their period ends sooner, not later. Contrast with **Future Subscription** (start in the future).

Rules:
- Allowed **only** when `plan.amount === 0`. Paid plans must start today (neither past nor future).
- The resulting period end must be strictly **after today** — a backdate whose whole period has already elapsed is rejected (this also bounds how far back a backdate can reach: less than one plan interval; there is no separate absolute cap).
- Permitted **only if no overlapping entitlement exists**: no subscription for the same user+company in status `ACTIVE`, `TRIALING`, `PAST_DUE`, or `PAUSED` whose paid period `[currentPeriodStart, currentPeriodEnd]` intersects the new subscription's whole span `[startDate, periodEnd]`. A `CANCELED` subscription never blocks (a member who gave up coverage may have the gap backfilled).
- Not gated by role: backdating can only ever **shorten** a member's period, so there is no incentive to abuse it.

**Session Pack (Bono)**:
A **Plan** that, in addition to its time interval, carries a finite number of **Session Credits**. Every plan has a time span; a Session Pack additionally caps how many schedules the member may attend within it. The pack ends when *either* its credits are exhausted *or* its period end is reached — whichever comes first. A plain time-based plan is simply a plan with unlimited credits. A Session Pack is **single-use**: it never auto-renews and a closed pack cannot be reactivated; buying another pack creates a new subscription (via **Future Subscription** if one is still live). Session Packs may be free/cash (`amount === 0`) like any other plan, but never carry a trial period.

**Session Credit (Crédito de sesión)**:
The consumable unit of a **Session Pack**: one credit entitles a member to register on one **Schedule**. A credit is **consumed at registration time** (not when the schedule takes place) — a no-show still spends the credit. A credit is **refunded** when the member unregisters before the schedule starts, or when the gym cancels the schedule (manually or via automatic cut-off). Joining a **Waitlist** does not consume a credit; it requires at least one available credit, and the credit is consumed at the moment of promotion — a waitlisted member with no credits left is skipped.

Rules:
- The credit total is **snapshotted onto the subscription** when it is created; editing the plan's credit count later never changes packs already sold.
- Reaching **0 credits does not end the subscription**: it stays active until its period end (the member keeps access to everything, including the schedules already booked) — only *new* registrations are refused. The end of the pack is communicated by exposing remaining credits, not by a new access state; `hasActive` remains the single gate.
- A registration made **by an admin or coach on the member's behalf** consumes a credit exactly like a self-registration, and is refused at 0 credits. To gift a session, the admin first adjusts credits (audited, with a mandatory reason, gated like radical cancellation) and then registers the member.
- A **gym-side cancellation always refunds** the registered members' credits — even for a schedule that has already taken place — unless the pack is already closed. A credit is lost only when the member themselves chooses not to attend.
- **Plan changes** (`changePlan`, prorated) are not allowed into or out of a Session Pack; the route is deferred cancellation + a **Future Subscription** with the new pack.

Rationale for consuming at booking time and for keeping the subscription alive at 0 credits: [ADR 0004](./docs/adr/0004-session-credits-consumed-at-booking.md).

**Restricted Schedule (Horario Restringido)**:
A **Schedule** that names a set of **Plans** it admits (`Schedule.allowedPlans`, many-to-many). An **empty set means unrestricted** — open to everyone, which is what every pre-existing schedule is and stays. A member may register only if their **currently live** subscription is to one of the named plans; the plans of the schedule and of the subscription always belong to the same company (tenancy is enforced on the write path by the `companyContext` filter and in the database by a trigger on the pivot table).

Rules:
- The gate is evaluated **only at registration time**. A booking already made is **never revoked** — not when an administrator adds the restriction to a schedule that already has attendees, not when the member's subscription lapses or switches plan before the class. Removing a non-qualifying member is a manual administrator action (`removeUserFromSchedule`).
- It is checked against the subscription that is live **now**, not the one that will be live on the class date: a **Future Subscription** to an allowed plan does **not** qualify.
- It applies to **every role** — there is no administrator or coach bypass, exactly like the **Session Credit** rule. Registration is self-service, so the caller is always the person being registered.
- It is ordered **after** booking limits and the advance-booking window (and after the credit check), so the refusal a member sees names the reason that actually applies: a member who holds the right plan but has no credits is told to buy credits, not to upgrade. Capacity is not one of those reasons — it is not a refusal but a fork between a seat and the waitlist, and the gate is evaluated **before** that fork.
- Refusal raises the dedicated validation error `PLAN_NOT_ALLOWED_IN_SCHEDULE`, distinct from the capacity, booking-limit and credit ones.
- The API exposes `Schedule.allowedPlans` (raw, for the backoffice) and `Schedule.planAccess` — a **per-caller** derived field `{ canRegister, reason, requiredPlans }` the mobile app consumes instead of re-implementing the rule. Its scope is this restriction only: it never absorbs capacity, credits or the booking window.

- It applies to the **Waitlist** too, checked twice — on joining and again on promotion — exactly like the **Session Credit** rule. A non-qualifying member is refused when joining, with the same error. On promotion a candidate who has lost eligibility is skipped and dropped from **that** waitlist only; the seat falls through to the next eligible candidate, and if nobody qualifies it is left free. A place already held is never revoked: a waitlist slot is an option on a seat, evaluated when exercised.
- The **Schedule Programmed** template does not carry a restriction yet (issue #12) — asking for one while creating a repeating schedule is refused rather than silently dropped.

Rationale for evaluating at booking, for ignoring Future Subscriptions and for the absence of any bypass or eviction: [ADR 0005](./docs/adr/0005-plan-restriction-evaluated-at-booking.md).

**Invariant — CANCELED means the paid period is over**:
A `CANCELED` subscription never holds a still-live paid period: `CANCELED ⇒ currentPeriodEnd <= now`. This now holds **by construction**, not by convention (see [ADR 0003](./docs/adr/0003-deferred-only-cancellation.md)). There are exactly two live routes into `CANCELED`, both invariant-preserving:

- **Deferred (default):** the billing CRON (`processBillingCycle`) fires when `currentPeriodEnd <= now`. Standard cancellation (`cancelSubscription`) is *always* deferred — it only sets `cancelAtPeriodEnd = true` and leaves `status`/`currentPeriodEnd` intact, so the member keeps access for the period they paid for. The `cancelAtPeriodEnd` input field is retained-but-ignored.
- **Radical (admin-only):** `radicalCancelSubscription` terminates immediately and *truncates* the period (`canceledAt = endedAt = currentPeriodEnd = now`, `nextBillingDate` cleared), forfeiting the member's remaining days. Gated by `plansPermissions.CREATE_UPDATE_DELETE`; requires a mandatory reason.

`adminOverride` can no longer transition to `CANCELED`. The old "replace a recently-cancelled subscription with a pending period" path (`findRecentCanceledWithPendingPeriod` / `replaceCanceledSubscription`, "Vertiente 3") — plus the caller-less `replaceSubscription` machinery — was provably dead once the invariant held and has been deleted. See [ADR 0003](./docs/adr/0003-deferred-only-cancellation.md).
