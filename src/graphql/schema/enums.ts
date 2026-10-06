export const graphqlEnums = `
enum NotificationType {
    message
    warning
    error
    info
}

enum UserRoleEnum {
    standard
    admin
    coach
}

enum ScheduleType {
    standard
    sparring
    free
    conditioning
    competition
}

"""Motivo por el que el llamante no puede inscribirse en un Restricted Schedule. Cubre SOLO la restriccion de planes: nunca aforo, creditos ni ventana de reserva anticipada."""
enum SchedulePlanAccessReason {
    NO_LIVE_SUBSCRIPTION
    PLAN_NOT_ALLOWED
}

enum ScheduleState {
    available
    cancelled
}

enum Currency {
    eur
    usd
    gbp
}

enum LogicalOperator {
    and
    or
}

enum PaymentMethodType {
    card
    sepa_debit
    us_bank_account
}

enum PaymentMethodStatus {
    active
    inactive
    expired
}

enum PlanInterval {
    day
    week
    month
    year
}

enum PlanStatus {
    active
    inactive
    archived
}

enum SubscriptionStatus {
    incomplete
    incomplete_expired
    trialing
    active
    past_due
    canceled
    unpaid
    paused
}

enum InvoiceStatus {
    draft
    open
    paid
    uncollectible
    void
}

enum TransactionStatus {
    pending
    succeeded
    failed
    canceled
    refunded
    partially_refunded
}

enum TransactionType {
    charge
    refund
    payment
    subscription
}

enum PlanFilterConditionEnum {
    with
    without
}

enum PaymentType {
    mensual
    anual
}

enum PlanFilterConditionEnum {
    with
    without
}
`;
