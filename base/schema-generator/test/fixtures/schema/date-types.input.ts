type Default<T, V extends T | string = T> = T;

// Test Date type transformations
interface UserProfile {
  name: string;
  createdAt: Date;
  lastLogin: Date | null;
  preferences: {
    timezone: string;
    updatedAt: Date;
  };
}

// Test Date with Default wrapper
interface EventLog {
  timestamp: Default<Date, "2023-01-01T00:00:00.000Z">;
  eventType: string;
}

// Test optional Date fields
interface Document {
  title: string;
  createdAt: Date;
  publishedAt?: Date;
  archivedAt?: Date | null;
}

interface SchemaRoot {
  userProfile: UserProfile;
  eventLog: EventLog;
  document: Document;
}
