import { DataSource } from "typeorm";
import { databaseOptions } from "./database.provider";

export { databaseOptions } from "./database.provider";
export default new DataSource(databaseOptions());
