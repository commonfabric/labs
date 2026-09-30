#!/usr/bin/swift
// extract-contacts.swift — Read Apple Contacts and output JSON to stdout.
//
// Usage: swift extract-contacts.swift
//
// First run will trigger macOS Contacts permission dialog.
// Output: JSON array of contact objects.

import Contacts
import Foundation

struct ContactEmail: Codable {
    let value: String
    let label: String?
}

struct ContactPhone: Codable {
    let value: String
    let label: String?
}

struct ContactAddress: Codable {
    let street: String
    let city: String
    let state: String
    let postalCode: String
    let country: String
    let label: String?
}

struct ContactRecord: Codable {
    let id: String
    let givenName: String
    let familyName: String
    let organizationName: String
    let jobTitle: String
    let emails: [ContactEmail]
    let phones: [ContactPhone]
    let addresses: [ContactAddress]
    let birthday: String?
    let note: String?
    let imageAvailable: Bool
}

func labelString(_ label: String?) -> String? {
    guard let label = label else { return nil }
    // Convert system labels like "_$!<Home>!$_" to readable names
    if let localized = CNLabeledValue<NSString>.localizedString(forLabel: label) as String? {
        return localized.lowercased()
    }
    return label
}

func formatBirthday(_ components: DateComponents?) -> String? {
    guard let c = components else { return nil }
    if let year = c.year, let month = c.month, let day = c.day {
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
    if let month = c.month, let day = c.day {
        return String(format: "%02d-%02d", month, day)
    }
    return nil
}
