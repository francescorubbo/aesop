# examples/mnist/train.py
import json
import os
import torch
import torch.nn as nn
import torch.optim as optim
from torchvision import datasets, transforms
from torch.utils.data import DataLoader

# ======================================================================
# AESOP SANDBOX
# The agent should focus its mutations on this architecture and the hyperparameters.
# ======================================================================
class BaselineModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.flatten = nn.Flatten()
        self.layer1 = nn.Linear(28 * 28, 32)
        self.relu = nn.ReLU()
        self.layer2 = nn.Linear(32, 10)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.flatten(x)
        x = self.relu(self.layer1(x))
        return self.layer2(x)

LEARNING_RATE: float = 0.01
EPOCHS: int = 1  # Kept short for rapid local testing
BATCH_SIZE: int = 64
# ======================================================================

def main():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    transform = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize((0.1307,), (0.3081,))
    ])
    
    # Use MNIST_DATA_DIR if provided, otherwise fallback to ./data
    data_dir = os.environ.get('MNIST_DATA_DIR', './data')
    
    # Download and load data
    train_dataset = datasets.MNIST(data_dir, train=True, download=True, transform=transform)
    test_dataset = datasets.MNIST(data_dir, train=False, transform=transform)
    
    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    test_loader = DataLoader(test_dataset, batch_size=1000, shuffle=False)
    
    model = BaselineModel().to(device)
    optimizer = optim.SGD(model.parameters(), lr=LEARNING_RATE)
    criterion = nn.CrossEntropyLoss()
    
    # Quick Training Loop
    model.train()
    for epoch in range(EPOCHS):
        for data, target in train_loader:
            data, target = data.to(device), target.to(device)
            optimizer.zero_grad()
            output: torch.Tensor = model(data)
            loss: torch.Tensor = criterion(output, target)
            loss.backward()
            optimizer.step()
            
    # Evaluation Loop
    model.eval()
    correct: int = 0
    with torch.no_grad():
        for data, target in test_loader:
            data, target = data.to(device), target.to(device)
            output = model(data)
            pred = output.argmax(dim=1, keepdim=True)
            correct += pred.eq(target.view_as(pred)).sum().item()
            
    accuracy: float = correct / len(test_dataset)
    
    # Write the result payload for Aesop's tournamentRatchet.ts to evaluate
    result_payload = {
        "accuracy": accuracy,
        "epochs": EPOCHS
    }
    
    with open("eval_result.json", "w") as f:
        json.dump(result_payload, f, indent=4)
        
    print(f"Validation complete. Accuracy: {accuracy:.4f}")

if __name__ == "__main__":
    main()