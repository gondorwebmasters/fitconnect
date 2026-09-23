export const graphqlEntities = `
scalar JSON
scalar DateTime

type PictureUrl {
    id: ID!
    name: String!
    url: String!
}

type UserWeight {
    id: ID!
    weight: Float!
    date: String!
    user: UserResumeResponse!
}

type TrainingTask {  
    id: ID!
    content: String!
    user: User
    date: String
    repeat: Boolean!
}

type Article {
    id: ID!
    publishedAt: String!
    title: String!
    description: String!
    link: String!
    image: String!
}

type Product {
    id: ID!
    name: String!
    description: String!
    price: Float!
    pictures: [PictureUrl]
}

type Promotion {
    id: ID!
    title: String!
    description: String!
    discountTag: String!
    originalPrice: Float!
    newPrice: Float!
    expiresAt: String!
    accentColor: String
    isHero: Boolean!
    isActive: Boolean!
    created_at: String!
    updated_at: String!
}

type Company {
    id: ID!
    name: String!
    code: String
    phoneNumber: String!
    email: String!
    address: String!
    logo: PictureUrl
    pictures: [PictureUrl]
    scheduleOptions: ScheduleOptions
    companyConfig: CompanyConfig
    amIPending: Boolean
}

type User {
    id: ID!
    name: String
    surname: String
    email: String!
    pictureUrl: PictureUrl
    nickname: String!
    isActive: Boolean
    isBlocked: Boolean
    blockedAt: DateTime
    churnedAt: DateTime
    birthDate: DateTime
    schedules: [Schedule]
    userWeights: [UserWeight]
    phoneNumber: String
    isVerified: Boolean
    companies: [Company]
    contextRole: UserRoleEnum
    isSuperAdmin: Boolean
    activeCompanyId: ID
    isPending: Boolean
    """Auth payload (login / getMe): { hasActive, subscriptionState, planName, status, isInTrial, trialEndsAt, startDate, endDate, cancelAtPeriodEnd, renewsAt, remainingCredits }. remainingCredits es null si el plan es ilimitado."""
    subscription: JSON
    permissions: [String]
}

type Schedule {
    id: ID!
    description: String
    title: String!
    age: Int
    users: [User]
    waitListUsers: [User]
    created_at: String!
    updated_at: String!
    startDate: DateTime!
    endDate: DateTime!
    maxUsers: Int!
    admin: User!
    state: ScheduleState!
    type: ScheduleType!
    """Restricted Schedule: planes que admite este schedule. Lista vacia = sin restriccion (abierto a todo el mundo)."""
    allowedPlans: [Plan!]!
    """Derivado **por llamante**: si el llamante puede inscribirse en lo que respecta a la restriccion de planes, y por que no. Alcance limitado a esa regla: no absorbe aforo, creditos ni ventana de reserva. No cacheable entre usuarios."""
    planAccess: SchedulePlanAccess!
}

"""Resultado por llamante del gate de Restricted Schedule. reason es null cuando canRegister es true. requiredPlans esta vacio en un schedule sin restriccion."""
type SchedulePlanAccess {
    canRegister: Boolean!
    reason: SchedulePlanAccessReason
    requiredPlans: [Plan!]!
}

type ScheduleResume {
    id: ID!
    startDate: DateTime!
    maxUsers: Int!
    state: ScheduleState!
    ocupancy: Int!
}

type ScheduleProgrammed {
    id: ID!
    title: String!
    created_at: String!
    updated_at: String!
    daysOfWeek: [Int]
    startHour: String!
    endHour: String!
    maxUsers: Int!
    admin: User!
    description: String
    age: Int
    type: ScheduleType
}
    
type ScheduleOptions {
    id: ID!
    maxActiveReservations: Int!
    maxAdvanceBookingDays: Int!
    sameDayBookingAllowed: Boolean!
    fullOpenHours: Int!
    bookingCutoffMinutes: Int!
    minBookingsRequired: Int!
    quotaWarningThresholds: [Int]!
}

type CompanyConfig {
    pollsEnabled: Boolean!
    productsEnabled: Boolean!
    chatEnabled: Boolean!
    trainingEnabled: Boolean!
}

type Poll {
    id: ID!
    created_at: String!
    updated_at: String!
    endDate: String!
    title: String!
    options: [String]!
    admin: User!
    pollVotes: [PollVote]
}

type PollVote {
    poll: IdResponse!
    user: User!
    optionSelected: String!
}

type Rating {
    id: ID!
    created_at: String!
    updated_at: String!
    score: Int!
    comment: String
    user: User!
}

type Message {
    id: ID!
    created_at: String!
    text: String!
    isFixed: Boolean
    fixedEndDate: String
    fixedAdmin: UserResumeResponse
    sender: UserResumeResponse!
    receiver: UserResumeResponse
    isForumMessage: Boolean!
}

type Conversation {
    otherUserId: ID
    messages: [Message]
}

# ── BILLING ──────────────────────────────────────────────────────────

"""
Perfil de facturación de un usuario.
"""
type Customer {
    id: ID!
    created_at: String!
    updated_at: String!
    user: User
    isActive: Boolean!
    defaultCurrency: Currency!
    paymentMethods: [PaymentMethod]
}

"""
Método de pago almacenado (card-on-file).
El token de la tarjeta lo gestiona el procesador externo (Stripe).
Nunca se exponen datos sensibles de la tarjeta.
"""
type PaymentMethod {
    id: ID!
    created_at: String!
    customer: Customer!
    type: PaymentMethodType!
    status: PaymentMethodStatus!
    brand: String
    last4: String
    expiryMonth: Int
    expiryYear: Int
    fingerprint: String
    country: String
    isDefault: Boolean!
    displayName: String
    isExpired: Boolean
    metadata: JSON
}

type Plan {
    id: ID!
    created_at: String!
    updated_at: String!
    name: String!
    description: String
    amount: Float!
    currency: Currency!
    interval: PlanInterval!
    intervalCount: Int!
    trialPeriodDays: Int
    """Session Pack (Bono): nº de créditos de sesión del plan. null = ilimitado (plan temporal clásico). Un pack nunca tiene trial ni se auto-renueva."""
    sessionCount: Int
    status: PlanStatus!
    isActive: Boolean!
    features: [String]
    subscriptions: [Subscription]
    metadata: JSON
}

"""
Suscripción de un usuario a un plan.
nextBillingDate y failedPaymentAttempts controlan el ciclo de cobro propio.
"""
type Subscription {
    id: ID!
    created_at: DateTime!
    updated_at: DateTime!
    user: User!
    customer: Customer!
    plan: Plan!
    defaultPaymentMethod: PaymentMethod
    status: SubscriptionStatus!
    currentPeriodStart: DateTime
    currentPeriodEnd: DateTime
    trialStart: DateTime
    trialEnd: DateTime
    canceledAt: DateTime
    cancelAtPeriodEnd: Boolean
    endedAt: DateTime
    quantity: Int
    nextBillingDate: DateTime
    failedPaymentAttempts: Int!
    isActive: Boolean
    isInTrial: Boolean
    isPastDue: Boolean
    daysUntilRenewal: Int
    """Snapshot de Plan.sessionCount al crear la suscripción. null = ilimitado."""
    creditsTotal: Int
    """Créditos de sesión consumidos."""
    creditsUsed: Int!
    """creditsTotal − creditsUsed (derivado). null = ilimitado."""
    remainingCredits: Int
    metadata: JSON
    transactions: [Transaction]
}

"""
Factura generada por el sistema de billing interno.
El número de factura (INV-YYYY-NNNNN) lo genera el propio sistema.
"""
type Invoice {
    id: ID!
    created_at: String!
    updated_at: String!
    invoiceNumber: String
    user: User!
    subscription: Subscription
    status: InvoiceStatus!
    subtotal: Float!
    tax: Float!
    total: Float!
    amountPaid: Float!
    amountRemaining: Float!
    currency: Currency!
    dueDate: String
    paidAt: String
    periodStart: String
    periodEnd: String
    description: String
    lineItems: JSON
    isPaid: Boolean!
    isOverdue: Boolean!
    formattedTotal: String!
}

"""
Registro de cada movimiento de dinero.
externalTransactionId referencia la operación en Stripe (PaymentIntent.id).
"""
type Transaction {
    id: ID!
    created_at: String!
    externalTransactionId: String
    user: User
    paymentMethod: PaymentMethod
    subscription: Subscription
    invoice: Invoice
    type: TransactionType!
    status: TransactionStatus!
    amount: Float!
    amountRefunded: Float!
    currency: Currency!
    description: String
    failureReason: String
    metadata: JSON
}



type Notification {
    id: ID!
    created_at: String!
    updated_at: String!
    type: NotificationType!
    title: String!
    message: String! 
    link: String
    read: Boolean!
    user: IdResponse!
    company: Company
}

type Stats {
    total: Int
    active: Int
    expired: Int
    hasDefault: Boolean
    byBrand: JSON
}

type Tokens {
    token: String
    refreshToken: String
}

type UserStats {
    totalUsers: Int!
    notActiveUsers: Int!
    blockedUsers: Int!
    newUsers: Int!
    pendingUsers: Int!
}

type AdminStats {
    users: UserStats!
    schedules: Int!
    polls: Int!
    plans: Int!
    subscriptions: Int!
    transactions: Int!
    notifications: Int!
}

type MonthCount {
    month: String!
    count: Int!
}

type AgeRangeCount {
    range: String!
    count: Int!
}

type MonthAmount {
    month: String!
    amount: Float!
}

type ReportMetrics {
    totalUsers: Int!
    churnedUsers: Int!
    newUsersByMonth: [MonthCount!]!
    churnedUsersByMonth: [MonthCount!]!
    usersByAgeRange: [AgeRangeCount!]!
    totalRevenue: Float!
    revenueByMonth: [MonthAmount!]!
    productsSold: Int!
    promotionsApplied: Int!
    promotionsAppliedByMonth: [MonthCount!]!
    subscriptionsByMonth: [MonthCount!]!
    schedulesByMonth: [MonthCount!]!
    transactionsByMonth: [MonthCount!]!
}

type GroupUser {
    standard: [User]
    specialRoles: [User]
}

type ExpoPushToken {
    id: ID!
    token: String!
}
`;
