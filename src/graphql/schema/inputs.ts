export const graphqlInputs = `

input CreateProductInput {
    name: String!
    description: String!
    price: Float!
}

input CreatePromotionInput {
    title: String!
    description: String!
    discountTag: String!
    originalPrice: Float!
    newPrice: Float!
    expiresAt: String!
    accentColor: String
    isHero: Boolean
    isActive: Boolean
}

input UpdatePromotionInput {
    title: String
    description: String
    discountTag: String
    originalPrice: Float
    newPrice: Float
    expiresAt: String
    accentColor: String
    isHero: Boolean
    isActive: Boolean
}

input AddUserWeightInput {
    userId: ID!
    weight: Float!
    date: String!
}

input CreateTrainingTaskInput {
    content: String!
    userId: ID
    date: String!
    repeat: Boolean!
}

input UpdateUserInput {
    id: ID!
    name: String
    surname: String
    email: String!
    phoneNumber: String
    nickname: String!
    isActive: Boolean
    isBlocked: Boolean
    role: UserRoleEnum
    activeCompanyId: String
    birthDate: DateTime
}

input CreateCompanyInput {
    name: String!
    phoneNumber: String!
    email: String!
    address: String!
    code: String!
}

input CompanyDataInput {
    name: String
    address: String
    phoneNumber: String
    email: String
    code: String
    companyConfig: CompanyConfigInput
}

input CompanyConfigInput {
    pollsEnabled: Boolean
    productsEnabled: Boolean
    chatEnabled: Boolean
    trainingEnabled: Boolean
}

input ScheduleOptionsInput {
    maxActiveReservations: Int
    maxAdvanceBookingDays: Int
    sameDayBookingAllowed: Boolean
    fullOpenHours: Int
    bookingCutoffMinutes: Int
    minBookingsRequired: Int
    quotaWarningThresholds: [Int]
}

input UpdateScheduleInput {
    id: ID!
    title: String
    description: String
    age: Int
    type: ScheduleType
    startHour: String
    endHour: String
    maxUsers: Int
    admin: ID
    date: String
}

input UpdateScheduleProgrammedInput {
    id: ID!
    daysOfWeek: [Int]
    startHour: String
    endHour: String
    maxUsers: Int
    admin: ID
    title: String
    description: String
    type: ScheduleType
    age: Int
}

input CreateUserInput {
    email: String!
    nickname: String!
    password: String!
    role: UserRoleEnum!
}

input CreateCompanyMemberInput {
    email: String!
    nickname: String!
    password: String!
    role: UserRoleEnum!
    isActive: Boolean
}

input CreatePollVoteInput {
    pollId: ID!
    option: Int!
}

input UpdatePasswordInput {
    currentPassword: String!
    newPassword: String!
    confirmPassword: String!
}

input AdminUpdatePasswordInput {
    userId: ID!
    newPassword: String!
    confirmPassword: String!
}

input CreateScheduleInput {
    title: String!
    description: String!
    age: Int
    type: ScheduleType!
    startHour: String!
    endHour: String!
    days: [Int]!
    repeat: Boolean
    maxUsers: Int!
    admin: ID!
    date: String
}

input UpdateScheduleOptionsInput {
    maxActiveReservations: Int!
    maxAdvanceBookingDays: Int!
    sameDayBookingAllowed: Boolean!
    fullOpenHours: Int!
    bookingCutoffMinutes: Int!
    minBookingsRequired: Int!
}

input CreateScheduleDevelopmentInput {
    title: String!
    startTime: String
    endTime: String
    maxUsers: Int!
    state: ScheduleState
}

input PollFilter {
    since: String!
}

input CreatePollInput {
    title: String!
    options: [String]!
    endDate: String!
}

input CreateOrUpdateRatingInput {
    score: Int!
    comment: String
}

input CreateMessageInput {
    text: String!
    receiverId: ID
    isFixed: Boolean
    fixedDuration: Boolean
    isForumMessage: Boolean
}

input UserInput {
    name: String!
    surname: String!
    password: String!
    email: String!
    nickname: String!
}

input ChangePasswordInput {
    currentPassword: String!
    newPassword: String!
}

input SendNotificationInput {
    title: String!
    body: String!
    forAll: Boolean!
    """IDs de usuarios destinatarios — envío dirigido (broadcast a una selección)."""
    userIds: [ID!]
    type: NotificationType
    """Categoría interactiva registrada en el cliente (ver notification-categories.ts). Opcional: sin ella, la notificación se comporta como hoy, sin botones."""
    categoryIdentifier: String
}

input PlanFilterInput {
    id: ID!
    condition: PlanFilterConditionEnum!
}

# ── BILLING ──────────────────────────────────────────────────────────

input CreatePlanInput {
    name: String!
    description: String
    amount: Float!
    currency: Currency
    interval: PlanInterval!
    intervalCount: Int
    trialPeriodDays: Int
    """Session Pack: nº de sesiones. Vacío = ilimitado. Incompatible con trialPeriodDays > 0."""
    sessionCount: Int
    features: [String]
    metadata: JSON
}

input UpdatePlanInput {
    id: ID!
    name: String
    description: String
    amount: Float
    trialPeriodDays: Int
    """Session Pack: nº de sesiones. null = vuelve a ilimitado. No altera suscripciones ya creadas (snapshot)."""
    sessionCount: Int
    features: [String]
    metadata: JSON
    status: PlanStatus
    isActive: Boolean
}

input CreateCustomerInput {
    userId: ID!
    currency: Currency
    metadata: JSON
}


input UpdateCustomerInput {
    customerId: ID!
    currency: Currency
    isActive: Boolean
    metadata: JSON
}

input CreateSubscriptionInput {
    planId: ID!
    userId: ID!
    paymentMethodId: ID
    trialPeriodDays: Int
    quantity: Int
    metadata: JSON
    startDate: String
}

input UpdateSubscriptionInput {
    subscriptionId: ID!
    planId: ID
    paymentMethodId: ID
    quantity: Int
    metadata: JSON
}

input CancelSubscriptionInput {
    subscriptionId: ID!
    """OBSOLETO — se ignora en el servidor. La cancelacion es siempre diferida (al fin del periodo pagado). Retenido para compatibilidad con el backoffice. Ver ADR 0003."""
    cancelAtPeriodEnd: Boolean
    cancellationReason: String
}

input RadicalCancelSubscriptionInput {
    subscriptionId: ID!
    """Obligatorio — queda en el audit log atribuido al admin"""
    reason: String!
}

input ChangePlanInput {
    subscriptionId: ID!
    newPlanId: ID!
    prorate: Boolean
}


input AdminOverrideSubscriptionInput {
    subscriptionId: ID!
    status: SubscriptionStatus
    currentPeriodEnd: String
    nextBillingDate: String
    resetFailedAttempts: Boolean
    """Obligatorio — queda en el audit log"""
    reason: String!
}

input CreateChargeInput {
    userId: ID!
    amount: Int!
    currency: Currency
    paymentMethodId: ID
    invoiceId: ID
    subscriptionId: ID
    description: String
    metadata: JSON
}

input RefundTransactionInput {
    transactionId: ID!
    amount: Float
    reason: String
    metadata: JSON
}


`;
