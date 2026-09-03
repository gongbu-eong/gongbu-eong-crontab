import sql from 'mssql';

const config: sql.config = {
  server: process.env.MSSQL_SERVER || '',
  database: process.env.MSSQL_DATABASE || '',
  user: process.env.MSSQL_USER || '',
  password: process.env.MSSQL_PASSWORD || '',
  options: {
    encrypt: false,
  },
};

export async function executeQuery(query: string) {
  let pool: sql.ConnectionPool | undefined;

  try {
    pool = await sql.connect(config);
    const result = await pool.request().query(query);
    return result.recordset;
  } catch (error) {
    throw error;
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}
