# Fitconnect Backend

Domain glossary and terms for the Fitconnect backend system.

## Language

**Schedule**:
A planned session or class at a gym/company, which has a specific capacity (maximum users) and an assigned administrator.
Deleting a schedule that still has registered users is treated as a **gym-side cancellation**: every registered member with a Session Pack gets their credit back (unless the schedule was already _cancelled_, in which case the refund already happened) and the members are notified, then the schedule is physically deleted. The preferred route for a class that will not take place is still to _cancel_ it (deactivated but preserved in history); deletion is for schedules created by mistake. Past schedules are also preserved and never deleted automatically when their recurring template (Schedule Programmed) is removed.

**Restricted Schedule (Horario Restringido)**:
A **Schedule** that carries a non-empty set of **Plans** (`allowedPlans`) and admits only members whose subscription is to one of them. An **empty set means no restriction** — the schedule is open to every member. The restriction is a *set*, not a single plan: the singular case ("only Premium") is a set of one.

Rules:
- **Evaluated only at registration time.** The gate asks: does this member have a *currently live* subscription (`hasActive`) whose plan is in `allowedPlans`? A **Future Subscription** to the required plan does **not** qualify, even if it will have started by the time the class takes place — the check is about now, not about the class date.
- **A booking already made is firm.** Nothing revokes it: not the administrator restricting the schedule afterwards, not the member's subscription expiring or switching to another plan before the class. Same principle as reaching 0 **Session Credits** (see [ADR 0004](./docs/adr/0004-session-credits-consumed-at-booking.md)) — losing eligibility blocks *new* registrations, it never evicts. An administrator who wants a non-qualifying member out removes them by hand.
- **Waitlist is checked twice**: on joining (so nobody waits for a seat they could never take) and again on promotion (eligibility may have lapsed in between). A candidate who no longer qualifies is skipped and dropped from that waitlist, the next one is tried, and if nobody can take it the seat stays free — identical to the out-of-credits rule.
- **No role bypass.** The restriction applies to members, coaches and administrators alike; an administrator registering themselves on a Premium-only schedule without a live Premium subscription is refused. This follows from registration being self-service only (`addUserToSchedule` takes a schedule, never a target user) and matches the credit rule in ADR 0004.
- **A restricted plan may still be archived.** Archiving a Plan that schedules require is permitted and warns the administrator how many schedules reference it. Those schedules become closed in practice — members holding a live subscription keep access until it lapses, and no new member can ever qualify. The restriction is **never silently dropped**: quietly reopening a restricted class would be a silent access failure.

**Restriction on the template**: `ScheduleProgrammed` carries `allowedPlans` too, and seeds it into the Schedules it spawns. An individual Schedule may diverge afterwards, but **editing the template overwrites every future Schedule**, exactly as it already does for `title`, `maxUsers`, `type`, `age` and `admin`.

**Exposure**: the API exposes both `allowedPlans` (the backoffice needs it to edit the restriction) and a per-user derived field saying whether the caller may register and why not (the mobile front needs it so the access rule lives in the back only). The derived field covers *this* restriction alone — capacity, credits and the booking window keep their own signals, so it does not become a catch-all.

Rationale for evaluating only at registration and never evicting: [ADR 0005](./docs/adr/0005-plan-restriction-evaluated-at-booking.md).

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
The consumable unit of a **Session Pack**: one credit entitles a member to register on one **Schedule**. A credit is **consumed at registration time** (not when the schedule takes place) — a no-show still spends the credit. A credit is **refunded** when the member unregisters before the schedule starts, or when the gym cancels the schedule (manually or via automatic cut-off). Joining a **Waitlist** does not consume a credit; it requires at least one available credit, and the credit is consumed at the moment of promotion — a waitlisted member with no credits left is skipped and dropped from that waitlist (the next candidate is tried; if nobody can take it, the seat stays free).

Rules:
- The credit total is **snapshotted onto the subscription** when it is created; editing the plan's credit count later never changes packs already sold.
- Reaching **0 credits does not end the subscription**: it stays active until its period end (the member keeps access to everything, including the schedules already booked) — only *new* registrations are refused. The end of the pack is communicated by exposing remaining credits, not by a new access state; `hasActive` remains the single gate.
- A registration made **by an admin or coach on the member's behalf** consumes a credit exactly like a self-registration, and is refused at 0 credits. The refusal is the validation error `NO_SESSION_CREDITS`; consumption and refund are recorded in the subscription history as `credit_consumed` / `credit_refunded` with the `scheduleId`. To gift a session, the admin first adjusts credits (audited, with a mandatory reason, gated like radical cancellation) and then registers the member.
- A **gym-side cancellation always refunds** the registered members' credits — even for a schedule that has already taken place — unless the pack is already closed. A credit is lost only when the member themselves chooses not to attend.
- **Plan changes** (`changePlan`, prorated) are not allowed into or out of a Session Pack; the route is deferred cancellation + a **Future Subscription** with the new pack.

Rationale for consuming at booking time and for keeping the subscription alive at 0 credits: [ADR 0004](./docs/adr/0004-session-credits-consumed-at-booking.md).

**Invariant — CANCELED means the paid period is over**:
A `CANCELED` subscription never holds a still-live paid period: `CANCELED ⇒ currentPeriodEnd <= now`. This now holds **by construction**, not by convention (see [ADR 0003](./docs/adr/0003-deferred-only-cancellation.md)). There are exactly two live routes into `CANCELED`, both invariant-preserving:

- **Deferred (default):** the billing CRON (`processBillingCycle`) fires when `currentPeriodEnd <= now`. Standard cancellation (`cancelSubscription`) is *always* deferred — it only sets `cancelAtPeriodEnd = true` and leaves `status`/`currentPeriodEnd` intact, so the member keeps access for the period they paid for. The `cancelAtPeriodEnd` input field is retained-but-ignored.
- **Radical (admin-only):** `radicalCancelSubscription` terminates immediately and *truncates* the period (`canceledAt = endedAt = currentPeriodEnd = now`, `nextBillingDate` cleared), forfeiting the member's remaining days. Gated by `plansPermissions.CREATE_UPDATE_DELETE`; requires a mandatory reason.

`adminOverride` can no longer transition to `CANCELED`. The old "replace a recently-cancelled subscription with a pending period" path (`findRecentCanceledWithPendingPeriod` / `replaceCanceledSubscription`, "Vertiente 3") — plus the caller-less `replaceSubscription` machinery — was provably dead once the invariant held and has been deleted. See [ADR 0003](./docs/adr/0003-deferred-only-cancellation.md).
