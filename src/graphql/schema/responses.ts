export const graphqlResponses = `
interface BasicResponse {
    code: String!
    success: Boolean!
    message: String!
}

type DefaultResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
}

type PresignedUrlResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    presignedUrl: String!
    key: String!
}

type UserWeightResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    userWeight: UserWeight
    userWeights: [UserWeight]
}

type TrainingTaskResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    trainingTask: TrainingTask
    trainingTasks: [TrainingTask]
}

type SchedulesStats {
    dayAndTime: String!
    ratio: Float!
}

type SchedulesStatsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    stats: [[SchedulesStats]]!
}

type SubscriptionsStats {
    planId: String!
    planName: String!
    count: Int!
}

type SubscriptionsStatsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    stats: [SubscriptionsStats]!
}

type ArticleResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    article: Article
    articles: [Article]
    hasMore: Boolean
}

type ProductResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    product: Product
    products: [Product]
}

type PromotionResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    promotion: Promotion
    promotions: [Promotion]
}

type UserResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    user: User
    users: [User]
    groupBy: GroupUser
}

type ScheduleResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    schedule: Schedule
    schedules: [Schedule]
}

type ScheduleResumeResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    schedulesResume: [ScheduleResume]
    scheduleOptions: ScheduleOptions
}

type ScheduleOptionsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    scheduleOptions: ScheduleOptions
}

type ScheduleProgrammedResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    scheduleProgrammed: ScheduleProgrammed
    schedulesProgrammed: [ScheduleProgrammed]
}

type LoginResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    user: User
    isNewUser: Boolean
    companies: [Company]
    tokens: Tokens
}

type MeResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    user: User
    companies: [Company]
}

type CompanyResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    company: Company
    companies: [Company]
}

type NotificationResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    notification: Notification
    notifications: [Notification]
    hasMore: Boolean
}

type PollResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    poll: Poll
    polls: [Poll]
}

type RatingResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    rating: Rating
    ratings: [Rating]
    averageScore: Float
    ratingsCount: Int
}

type ConversationResponse {
    messages: [[Message]]
    hasMore: Boolean
}

type MessageResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    sms: Message
    conversations: [[Message]]
    conversation: ConversationResponse
}

type IdResponse {
    id: ID!
}

type UserResumeResponse {
    id: ID!
    nickname: String!
    pictureUrl: PictureUrl
    contextRole: UserRoleEnum
}

type AdminStatsResponse {
    code: String!
    success: Boolean!
    message: String!
    stats: AdminStats
}

type ReportMetricsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    metrics: ReportMetrics
}

type RegisterTokenResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
}

type SendNotificationResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
}

type GlobalSystemStatsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    totalUsers: Int
    totalCompanies: Int
}

# ── BILLING RESPONSES ─────────────────────────────────────────────────

type CustomerResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    customer: Customer
    customers: [Customer]
}

type PaymentMethodResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    paymentMethod: PaymentMethod
    paymentMethods: [PaymentMethod]
    isValid: Boolean
    errors: [String]
}

type StatsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    stats: Stats
}

type PlanResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    plan: Plan
    plans: [Plan]
}

type SubscriptionHistoryEntry {
    event: String!
    actor: String!
    detail: String!
    timestamp: String!
    """Schedule asociado (eventos credit_consumed / credit_refunded)."""
    scheduleId: String
    """Delta aplicado (evento credit_adjusted)."""
    delta: Int
    """Motivo del ajuste (evento credit_adjusted)."""
    reason: String
}

type SubscriptionHistoryResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    history: [SubscriptionHistoryEntry]
}

type SubscriptionResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    subscription: Subscription
    subscriptions: [Subscription]
}

type InvoiceResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    invoice: Invoice
    invoices: [Invoice]
}

type InvoiceStatsData {
    total: Int!
    paid: Int!
    pending: Int!
    overdue: Int!
    totalAmount: Float!
    paidAmount: Float!
    pendingAmount: Float!
    overdueAmount: Float!
}

type InvoiceStatsResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    stats: InvoiceStatsData
}

type TransactionResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    transaction: Transaction
    transactions: [Transaction]
    summary: JSON
}

# ── STRIPE CONNECT (Modelo B) ───────────────────────────────────────────

"""
Datos del SetupIntent que el frontend necesita para confirmar la tarjeta
con Stripe Elements / SDK móvil antes de llamar a addPaymentMethod.
"""
type ClientTokenData {
    clientToken: String!
    setupIntentId: String
}

type ClientTokenResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    data: ClientTokenData
}

type PaymentOAuthUrlResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    url: String
}

type PaymentConnectionStatus {
    isConnected: Boolean!
    accountId: String
    status: String
    connectedAt: String
    chargesEnabled: Boolean!
    payoutsEnabled: Boolean!
    missingRequirements: [String]
    disabledReason: String
}

type PaymentConnectionStatusResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    status: PaymentConnectionStatus
}

type TokenizeCardData {
    nonce: String!
}

type TokenizeCardResponse implements BasicResponse {
    code: String!
    success: Boolean!
    message: String!
    data: TokenizeCardData
}
`;
