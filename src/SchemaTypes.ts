import { PromisesRemapped, WholeSchema, WholeSchemaKeys } from "clowdr-db-schema/src/classes/DataLayer/WholeSchema";

export type ParseObjectType<K extends WholeSchemaKeys> = Parse.Object<PromisesRemapped<WholeSchema[K]["value"]>>;
export type ConferenceT = ParseObjectType<"Conference">;
export type ConferenceConfigT = ParseObjectType<"ConferenceConfiguration">;
export type RoleT = Parse.Role<PromisesRemapped<WholeSchema["_Role"]["value"]>>;
export type TextChatT = ParseObjectType<"TextChat">;
export type VideoRoomT = ParseObjectType<"VideoRoom">;

export const Conference: new () => ConferenceT = Parse.Object.extend("Conference");
export const ConferenceConfig: new () => ConferenceConfigT = Parse.Object.extend("ConferenceConfiguration");
export const Role: new (name: string, acl: Parse.ACL) => RoleT = Parse.Role.extend("_Role");
export const TextChat: new () => TextChatT = Parse.Object.extend("TextChat");
export const VideoRoom: new () => VideoRoomT = Parse.Object.extend("VideoRoom");

// let ConferenceAccess = Parse.Object.extend("ConferenceAccess");
// let ConferenceConfig = Parse.Object.extend("ConferenceConfiguration");
// let PrivilegedAction = Parse.Object.extend("PrivilegedAction");
// let LiveActivity = Parse.Object.extend("LiveActivity");
// let UserProfile = Parse.Object.extend("UserProfile");
// let BondedChannel = Parse.Object.extend("BondedChannel");
// let SocialSpace = Parse.Object.extend("SocialSpace");
// let User = Parse.Object.extend("User");
