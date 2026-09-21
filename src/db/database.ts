import { Sequelize, DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';

export function createDatabase(url: string) {
  const sequelize = new Sequelize(url, {
    dialect: 'postgres', logging: false,
    pool: { max: 25, min: 0, acquire: 15000, idle: 1000 },
    dialectOptions: { application_name: 'payment-concurrency-lab', statement_timeout: 10000 },
    retry: { max: 0 },
  });
  class Account extends Model<InferAttributes<Account>, InferCreationAttributes<Account>> {
    declare id: string;
    declare name: string;
    declare balance: number;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  Account.init({
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.STRING(100), allowNull: false },
    balance: { type: DataTypes.INTEGER, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  }, { sequelize, tableName: 'accounts', underscored: true });

  class Payment extends Model<InferAttributes<Payment>, InferCreationAttributes<Payment>> {
    declare id: string;
    declare senderId: string;
    declare receiverId: string;
    declare amount: number;
    declare idempotencyKey: string;
    declare status: 'COMPLETED';
    declare createdAt: CreationOptional<Date>;
  }
  Payment.init({
    id: { type: DataTypes.UUID, primaryKey: true },
    senderId: { type: DataTypes.UUID, allowNull: false },
    receiverId: { type: DataTypes.UUID, allowNull: false },
    amount: { type: DataTypes.INTEGER, allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(128), allowNull: false, unique: 'payments_idempotency_key_unique' },
    status: { type: DataTypes.STRING(16), allowNull: false },
    createdAt: DataTypes.DATE,
  }, { sequelize, tableName: 'payments', underscored: true, updatedAt: false });
  return { sequelize, Account, Payment };
}
export type Database = ReturnType<typeof createDatabase>;
