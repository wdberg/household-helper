import SwiftUI

struct SettingsView: View {
    @Environment(PhotoLibrary.self) var library
    @Environment(\.dismiss) var dismiss
    @State var confirmReset = false

    var body: some View {
        @Bindable var library = library
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading) {
                        Slider(value: $library.similarThreshold, in: 0.2...0.8, onEditingChanged: { editing in
                            if !editing { library.regroup() }
                        })
                        HStack {
                            Text("Stricter")
                            Spacer()
                            Text("Looser")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Similar photo matching")
                } footer: {
                    Text("Looser groups more photos together as \"similar\". Stricter only groups near-identical shots.")
                }

                Section {
                    VStack(alignment: .leading) {
                        Slider(value: $library.blurThreshold, in: 5...200, onEditingChanged: { editing in
                            if !editing { library.regroup() }
                        })
                        HStack {
                            Text("Only very blurry")
                            Spacer()
                            Text("Slightly soft too")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Blur sensitivity")
                } footer: {
                    Text("Currently \(library.blurry.count) photos count as blurry or dark.")
                }

                Section {
                    Button("Rescan from scratch", role: .destructive) { confirmReset = true }
                } footer: {
                    Text("The app remembers what it has already analysed so later scans are fast. Rescanning from scratch forgets that and starts over.")
                }

                Section("Privacy") {
                    Text("Photos never leave your phone. All analysis happens on the device, and nothing is uploaded or shared.")
                        .font(.subheadline)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Rescan from scratch?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Rescan", role: .destructive) {
                    dismiss()
                    Task { await library.clearCache() }
                }
            } message: {
                Text("The first scan of a large library can take several minutes.")
            }
        }
    }
}
