import Photos
import SwiftUI

@main
struct PhotoCleanupApp: App {
    @State var library = PhotoLibrary()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(library)
        }
    }
}

struct RootView: View {
    @Environment(PhotoLibrary.self) var library

    var body: some View {
        Group {
            switch library.authorization {
            case .authorized, .limited:
                HomeView()
            case .notDetermined:
                WelcomeView()
            default:
                AccessDeniedView()
            }
        }
        .overlay {
            if let message = library.busyMessage {
                BusyOverlay(message: message)
            }
        }
        .alert("Photo Cleanup", isPresented: Binding(
            get: { library.alertMessage != nil },
            set: { if !$0 { library.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(library.alertMessage ?? "")
        }
    }
}

struct BusyOverlay: View {
    let message: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
            VStack(spacing: 14) {
                ProgressView().controlSize(.large)
                Text(message)
                    .font(.headline)
                    .multilineTextAlignment(.center)
            }
            .padding(28)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        }
    }
}

struct WelcomeView: View {
    @Environment(PhotoLibrary.self) var library

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Image(systemName: "sparkles.rectangle.stack.fill")
                .font(.system(size: 72))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("Photo Cleanup").font(.largeTitle.bold())
                Text("Free up space on your iPhone without losing the photos that matter.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 14) {
                Feature(icon: "square.on.square", text: "Find duplicate photos and videos")
                Feature(icon: "livephoto", text: "Turn Live Photos into normal photos")
                Feature(icon: "camera.metering.unknown", text: "Spot blurry shots, screenshots and big videos")
                Feature(icon: "lock.shield", text: "Everything stays on your phone. Deleted items go to Recently Deleted for 30 days.")
            }
            Spacer()
            Button {
                Task { await library.requestAccess() }
            } label: {
                Text("Allow Photo Access").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(24)
    }

    private struct Feature: View {
        let icon: String
        let text: String
        var body: some View {
            Label {
                Text(text)
            } icon: {
                Image(systemName: icon).foregroundStyle(.tint).frame(width: 28)
            }
        }
    }
}

struct AccessDeniedView: View {
    var body: some View {
        ContentUnavailableView {
            Label("No Access to Photos", systemImage: "photo.badge.exclamationmark")
        } description: {
            Text("Photo Cleanup needs full access to your library to find duplicates and free up space. Turn it on in Settings › Photo Cleanup › Photos.")
        } actions: {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
    }
}
