import Parse from "parse/node";
import { PromisesRemapped, WholeSchema, WholeSchemaKeys } from "@clowdr-app/clowdr-db-schema/build/DataLayer/WholeSchema";

export type ParseObjectType<K extends WholeSchemaKeys> = Parse.Object<PromisesRemapped<WholeSchema[K]["value"]>>;
export type ConferenceT = ParseObjectType<"Conference">;
export type ConferenceConfigT = ParseObjectType<"ConferenceConfiguration">;
export type RoleT = Parse.Role<PromisesRemapped<WholeSchema["_Role"]["value"]>>;
export type TextChatT = ParseObjectType<"TextChat">;
export type UserT = Parse.User<PromisesRemapped<WholeSchema["_User"]["value"]>>;
export type UserProfileT = ParseObjectType<"UserProfile">;
export type VideoRoomT = ParseObjectType<"VideoRoom">;

export const Conference: new () => ConferenceT = Parse.Object.extend("Conference");
export const ConferenceConfig: new () => ConferenceConfigT = Parse.Object.extend("ConferenceConfiguration");
export const Role: new (name: string, acl: Parse.ACL) => RoleT = Parse.Role.extend("_Role");
export const TextChat: new () => TextChatT = Parse.Object.extend("TextChat");
export const User: new () => UserT = Parse.User.extend();
export const UserProfile: new () => UserProfileT = Parse.Object.extend("UserProfile");
export const VideoRoom: new () => VideoRoomT = Parse.Object.extend("VideoRoom");
