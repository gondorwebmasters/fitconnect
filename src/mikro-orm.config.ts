import { Migrator } from '@mikro-orm/migrations';
import { SeedManager } from '@mikro-orm/seeder/SeedManager';
import dotenv from 'dotenv';

import { Article } from './entities/Article';
import { Company } from './entities/Company';
import { CompanyConfig } from './entities/CompanyConfig';
import { Customer } from './entities/Customer';
import { Invoice } from './entities/Invoice';
import { Message } from './entities/Message';
import { Notification } from './entities/Notification';
import { PaymentMethod } from './entities/PaymentMethod';
import { Plan } from './entities/Plan';
import { Poll } from './entities/Poll';
import { PollVote } from './entities/PollVote';
import { Product } from './entities/Product';
import { ProductPurchase } from './entities/ProductPurchase';
import { Promotion } from './entities/Promotion';
import { PromotionRedemption } from './entities/PromotionRedemption';
import { PushToken } from './entities/PushToken';
import { Rating } from './entities/Rating';
import { RefreshToken } from './entities/RefreshToken';
import { Schedule } from './entities/Schedule';
import { ScheduleOptions } from './entities/ScheduleOptions';
import { ScheduleProgrammed } from './entities/ScheduleProgrammed';
import { ScheduleRegistration } from './entities/ScheduleRegistration';
import { Subscription } from './entities/Subscription';
import { TrainingTask } from './entities/TraningITask';
import { Transaction } from './entities/Transaction';
import { User } from './entities/User';
import { UserRole } from './entities/UserRole';
import { UserWeight } from './entities/UserWeight';

dotenv.config();

const isLocal = process.env.DB_ENV === 'local';

export default {
  entities: [
    Article,
    Company,
    CompanyConfig,
    Invoice,
    Message,
    PaymentMethod,
    Plan,
    Poll,
    PollVote,
    Product,
    ProductPurchase,
    Promotion,
    PromotionRedemption,
    PushToken,
    Rating,
    RefreshToken,
    Schedule,
    ScheduleOptions,
    ScheduleProgrammed,
    ScheduleRegistration,
    Customer,
    Subscription,
    TrainingTask,
    Transaction,
    User,
    UserRole,
    UserWeight,
    Notification,
  ],
  clientUrl: isLocal ? undefined : process.env.DATABASE_URL,
  dbName: isLocal ? process.env.DB_NAME || 'postgres' : undefined,
  user: isLocal ? process.env.DB_USERNAME || 'postgres' : undefined,
  password: isLocal ? process.env.DB_PASSWORD : undefined,
  host: isLocal ? process.env.DB_HOST || 'localhost' : undefined,
  port: Number.parseInt(process.env.DB_PORT || '5432'),
  allowGlobalContext: true,
  driver: require('@mikro-orm/postgresql').PostgreSqlDriver,
  migrations: {
    path: './src/migrations',
    pathTs: './src/migrations',
    dropTables: false, // Do not drop tables that are not defined in entities
    safe: true, // Only allow additive changes if possible (optional but good)
    snapshot: isLocal,
  },
  schemaGenerator: {
    disableForeignKeys: false,
    ignoreSchema: ['auth', 'realtime', 'storage', 'vault'],
  },
  extensions: [Migrator, SeedManager],
  debug: false, //process.env.NODE_ENV !== 'production',
  driverOptions: {
    connection: {
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    },
    family: 4,
  },
  pool: {
    min: 2,
    max: 10,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    propagateCreateError: false,
  },
  //subscribers : [PollVoteSubscriber],
  //    EntityRepository: [CustomPollRepository],
};
